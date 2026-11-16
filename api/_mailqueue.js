// Email queue (step 1 of retiring the Google Sheet): the database decides which emails are due, the Apps Script only
// sends them through Gmail and reports back. Nothing here changes what the sheet's timers do today; the script picks
// this up in step 2.
//
// Jobs
//   request   a Finance Team request not yet SENT, once (invoice date - "days before") at "time" has passed
//   reminder  a REMINDER invoice (client not on hold) once the next interval (days since the invoice date) is reached, from 10:00
// Times are India time. Each job has a key ("request:12", "reminder:57:2"; "reminder:57:?" when the count sent before the
// trail was kept is unknown, so the script counts the reminders in the Gmail thread and says whether one is due).
//
// email_log rows: would_send (report-only run), claimed (handed to the script, 15-minute lease), sent, failed, skipped.
// One unique index keeps a key from being claimed or sent twice.

const IST = 330 * 60000;
const LEASE_MIN = 15;
const REMINDER_TIME = '10:00';
export const istNow = (now = new Date()) => { const x = new Date(now.getTime() + IST).toISOString(); return { date: x.slice(0, 10), hm: x.slice(11, 16) }; };
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// same as the script's iyFill_: {{Name}} -> escaped value, new lines as <br>
export const fill = (template, values) => Object.keys(values).reduce((html, k) => html.split('{{' + k + '}}').join(esc(values[k]).replace(/\r?\n/g, '<br>')), String(template || ''));
const rupees = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const emails = (s) => String(s || '').split(/[;,\s]+/).filter(Boolean);
const key = (s) => String(s || '').trim().toLowerCase();

// Every email due now, with what the script needs to send it. problems: due but cannot go (missing email, template…).
export async function dueJobs(db, cfg, now = new Date()) {
  const t = istNow(now);
  const stamp = `${t.date} ${t.hm}`;
  const jobs = [];
  const problems = [];
  const [requests, reminders, clients] = await db.transaction([
    db`select id, invoice_type as "invoiceType", client, to_char(invoice_date, 'YYYY-MM-DD') as "invoiceDate", description, po_number as "poNumber",
              amount::float8 as amount, attachments from invoice_requests where upper(email_status) <> 'SENT' and invoice_date is not null order by invoice_date, id`,
    db`select id, client, invoice_number as "invoiceNumber", to_char(invoice_date, 'YYYY-MM-DD') as "invoiceDate", to_char(due_date, 'YYYY-MM-DD') as "dueDate",
              invoice_type as "invoiceType", email_thread as thread, reminders_sent as "remindersSent"
       from receivable_invoices where upper(status) = 'REMINDER' and invoice_date is not null order by invoice_date, id`,
    db`select name, emails, contact, on_hold as "onHold" from clients`,
  ]);
  const finance = emails(cfg.financeEmails);
  for (const q of requests) {
    if (`${addDays(q.invoiceDate, -(Number(cfg.requestDaysBefore) || 0))} ${cfg.requestTime || '10:00'}` > stamp) continue;
    const job = { key: `request:${q.id}`, kind: 'request', id: q.id, client: q.client, label: `Finance Team request · ${q.client} · ${q.invoiceType}` };
    if (!finance.length) { problems.push({ ...job, problem: 'Add the Finance Team emails in Automator Settings' }); continue; }
    if (!cfg.requestTemplate) { problems.push({ ...job, problem: 'Add the Finance Team request template in Automator Settings' }); continue; }
    jobs.push({
      ...job, to: finance[0], cc: finance.slice(1), subject: `Invoice Request: ${q.client} ${q.invoiceType}`,
      html: fill(cfg.requestTemplate, {
        InvoiceType: q.invoiceType, Client: q.client, PO_Number: q.poNumber || 'N/A', ItemDescription: q.description,
        AmountwithoutGST: rupees(q.amount), InvoiceDate: dmy(q.invoiceDate),
      }),
      attachments: String(q.attachments || '').split(/\s+/).filter(Boolean),
    });
  }
  const book = new Map(clients.map((c) => [key(c.name), c]));
  const intervals = (cfg.reminderIntervals || []).map(Number).filter((n) => n > 0);
  for (const r of reminders) {
    const reached = intervals.filter((n) => `${addDays(r.invoiceDate, n)} ${REMINDER_TIME}` <= stamp).length; // intervals whose day has come
    const known = r.remindersSent != null;
    const count = known ? r.remindersSent : null;
    if (known ? count >= intervals.length || count >= reached : reached === 0) continue;
    const seq = known ? count + 1 : null;
    const job = { key: `reminder:${r.id}:${seq ?? '?'}`, kind: 'reminder', id: r.id, client: r.client, seq,
      label: `Reminder ${seq ?? '(number from the Gmail thread)'} · ${r.client} · ${r.invoiceNumber || 'no invoice no.'}` };
    const c = book.get(key(r.client));
    if (!c) { problems.push({ ...job, problem: 'Client not in the client list' }); continue; }
    if (c.onHold) continue; // on hold: no reminders, not a problem
    const to = emails(c.emails);
    if (!to.length) { problems.push({ ...job, problem: 'The client has no email address' }); continue; }
    if (!cfg.reminderTemplate) { problems.push({ ...job, problem: 'Add the reminder email template in Automator Settings' }); continue; }
    jobs.push({
      ...job, to: to[0], cc: to.slice(1), thread: r.thread, invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate,
      intervals, due: reached, // the script sends only if the thread holds fewer than "due" reminders
      html: fill(cfg.reminderTemplate, {
        'Client Name': c.name, ContactPoint: c.contact || '', 'Invoice number': r.invoiceNumber, 'Due Date': dmy(r.dueDate), InvoiceType: r.invoiceType,
      }),
    });
  }
  // a key already sent, or claimed by a run still within its lease, is not handed out again
  await db`update email_log set status = 'expired' where status = 'claimed' and claimed_at < now() - make_interval(mins => ${LEASE_MIN})`;
  const keys = jobs.map((j) => j.key);
  const busy = keys.length ? new Set((await db`select job_key from email_log where job_key = any(${keys}::text[]) and status in ('claimed', 'sent')`).map((x) => x.job_key)) : new Set();
  return { now: stamp, jobs: jobs.filter((j) => !busy.has(j.key)), problems };
}

// The script asks for work. Report-only (dry): logs what would be sent (once per key per day) and hands nothing out.
// Otherwise each job is claimed; a job another run claimed in the meantime is dropped.
export async function claimJobs(db, cfg, dry, at = new Date()) {
  const { now, jobs, problems } = await dueJobs(db, cfg, at);
  const meta = (j) => ({ kind: j.kind, ref: j.id, seq: j.seq, to: [j.to, ...(j.cc || [])].join(', '), subject: j.subject || `Reminder · ${j.invoiceNumber || ''}` });
  if (dry) {
    for (const j of jobs) {
      const m = meta(j);
      await db`insert into email_log (job_key, kind, ref_id, seq, recipients, subject, status, day)
               values (${j.key}, ${m.kind}, ${m.ref}, ${m.seq}, ${m.to}, ${m.subject}, 'would_send', ${now.slice(0, 10)}::date)
               on conflict (job_key, day) where status = 'would_send' do nothing`;
    }
    return { dry: true, now, jobs, problems };
  }
  const out = [];
  for (const j of jobs) {
    const m = meta(j);
    const [row] = await db`insert into email_log (job_key, kind, ref_id, seq, recipients, subject, status, claimed_at, day)
                           values (${j.key}, ${m.kind}, ${m.ref}, ${m.seq}, ${m.to}, ${m.subject}, 'claimed', now(), ${now.slice(0, 10)}::date)
                           on conflict (job_key) where status in ('claimed', 'sent') do nothing returning id`;
    if (row) out.push({ ...j, jobId: row.id });
  }
  return { dry: false, now, jobs: out, problems };
}

// Logs an email the sheet's timers (or the app) sent outside the queue, so the trail and the report-only comparison see it.
export async function logSent(db, kind, refId, seq, extra = {}) {
  const k = kind === 'reminder' ? `reminder:${refId}:${seq ?? '?'}` : `${kind}:${refId}`;
  await db`insert into email_log (job_key, kind, ref_id, seq, recipients, subject, status, thread, sent_at, source, day)
           values (${k}, ${kind}, ${refId}, ${seq ?? null}, ${extra.to || ''}, ${extra.subject || ''}, 'sent', ${extra.thread || ''}, now(), ${extra.source || 'sheet'},
                   (now() at time zone 'Asia/Kolkata')::date)
           on conflict (job_key) where status in ('claimed', 'sent') do nothing`;
}

// The script's answer for a claimed job: sent (thread, reminder number), failed (error) or skipped (the thread already
// holds the reminders due; count = how many). Returns the log row so the caller can update the invoice / request.
export async function finishJob(db, body) {
  const id = Number(body.jobId);
  if (!Number.isInteger(id)) throw new Error('Invalid job');
  const [job] = await db`select id, job_key as key, kind, ref_id as "refId", seq, status from email_log where id = ${id}`;
  if (!job) throw new Error('Unknown job');
  if (job.status !== 'claimed' && job.status !== 'expired') return { job, already: true }; // reported twice
  const result = ['sent', 'failed', 'skipped'].includes(body.result) ? body.result : 'failed';
  const count = Number.isInteger(Number(body.count)) && Number(body.count) >= 0 ? Number(body.count) : null;
  // an unknown reminder number becomes known once the script has counted the thread
  const seq = job.kind === 'reminder' && job.seq == null && count != null ? (result === 'sent' ? count : null) : job.seq;
  const newKey = job.kind === 'reminder' && result === 'sent' ? `reminder:${job.refId}:${seq ?? '?'}` : job.key;
  const set = (k) => db`update email_log set status = ${result}, seq = ${seq}, job_key = ${k},
             thread = ${String(body.thread || '').slice(0, 200)}, error = ${String(body.error || '').slice(0, 500)}, sent_at = case when ${result === 'sent'} then now() end,
             source = 'queue' where id = ${id}`;
  // the same key already logged as sent by another row (a late answer after the claim expired and was sent again, or the
  // sheet's timer): keep this row apart so both stay in the log
  const taken = (await db`select 1 from email_log where job_key = ${newKey} and status in ('claimed', 'sent') and id <> ${id}`).length > 0;
  await set(taken ? `${newKey}#${id}` : newKey);
  return { job: { ...job, seq }, result, count };
}

export const recentLog = (db, limit = 60) => db`
  select l.id, l.job_key as key, l.kind, l.ref_id as "refId", l.seq, l.recipients, l.subject, l.status, l.error, l.source,
         to_char(coalesce(l.sent_at, l.claimed_at, l.created_at) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') as at,
         coalesce(r.client, q.client) as client, r.invoice_number as "invoiceNumber"
  from email_log l
  left join receivable_invoices r on l.kind <> 'request' and r.id = l.ref_id
  left join invoice_requests q on l.kind = 'request' and q.id = l.ref_id
  order by l.id desc limit ${limit}`;
