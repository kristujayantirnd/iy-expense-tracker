// Client Invoice Automator on the Receivables page (Admin and Finance Admin only).
// Talks to /api/client-invoices; the sheet rows and Gmail are reached through the sheet's Apps Script.
let inv = { config: null, clients: [], drafts: [], rowDrafts: {}, rows: [], admin: false, manageTab: 'NEW_ENTRY', dbMode: false, sheetWaiting: 0 };
// A row's key: its database id once Receivables is in the database, else its sheet row number.
const rkey = (r) => (r.id !== undefined ? r.id : r.row);
const rowByKey = (k) => inv.rows.find((x) => rkey(x) === k);

const TEMPLATES = [
  { key: 'requestTemplate', label: 'Finance Team request email', vars: ['InvoiceType', 'Client', 'PO_Number', 'ItemDescription', 'AmountwithoutGST', 'InvoiceDate'] },
  { key: 'firstTemplate', label: 'First email to the client (invoice attached)', vars: ['Client Name', 'ContactPoint', 'Invoice number', 'Due Date', 'InvoiceType'] },
  { key: 'reminderTemplate', label: 'Reminder email (reply in the same thread)', vars: ['Client Name', 'ContactPoint', 'Invoice number', 'Due Date', 'InvoiceType'] },
];
const SAMPLE = {
  InvoiceType: 'Service', Client: 'SAMPLE CLIENT PVT LTD', 'Client Name': 'SAMPLE CLIENT PVT LTD', PO_Number: 'N/A', ItemDescription: 'Retainer fee - Nov',
  AmountwithoutGST: '₹5,00,000.00', InvoiceDate: '01/11/2026', ContactPoint: 'Asha', 'Invoice number': 'VD/2026-27/99', 'Due Date': '16/12/2026',
};
const ROW_STATUS = { NEW_ENTRY: 'New entry', APPROVED: 'Approved', REMINDER: 'Emailed · reminders on', 'Payment Received': 'Payment received' };
const $id = (id) => document.getElementById(id);
// Live search: every typed word must appear somewhere in the row's text (case-insensitive).
const matches = (inputId, ...fields) => { const words = $id(inputId).value.toLowerCase().split(/\s+/).filter(Boolean); const hay = fields.join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); };
const isPaid = (r) => r.status.toLowerCase() === 'payment received';
// Invoice Extracts' type column says "...reimbursement of the expenses incurred." for reimbursement invoices.
const isReimbRow = (r) => /reimburs/i.test(r.invoiceType || '');
// Same key as the server's rowDraftKey: sheet row + client + invoice date.
const rowDraftKey = (r) => `${r.row}|${r.client.toLowerCase()}|${r.invoiceDateIso || ''}`;
const rowDraftOf = (r) => (r.draft !== undefined ? r.draft : inv.rowDrafts[rowDraftKey(r)]);
const localToday = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const modal = (id) => bootstrap.Modal.getOrCreateInstance($id(id));

// Result message: success stays 6 s, errors 15 s; either can be closed.
function toast(msg, ok = true) {
  const el = $id('iyToast');
  el.className = `position-fixed bottom-0 end-0 m-3 alert shadow d-flex gap-2 align-items-start ${ok ? 'alert-success' : 'alert-danger'}`;
  el.innerHTML = `<i class="fa-solid fa-${ok ? 'circle-check' : 'triangle-exclamation'} mt-1"></i><span style="flex:1"></span><button type="button" class="btn-close btn-sm" aria-label="Close" onclick="this.parentElement.classList.add('d-none')"></button>`;
  el.querySelector('span').textContent = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('d-none'), ok ? 6000 : 15000);
}

// "Please wait" notice while the server is working; returns the function that ends it. Nested calls share one notice.
function busy(msg = 'Saving…') {
  const el = $id('iyBusy');
  busy.n = (busy.n || 0) + 1;
  el.querySelector('.iy-busy-text').textContent = msg;
  el.classList.remove('d-none');
  document.body.style.cursor = 'progress';
  let done = false;
  return () => {
    if (done) return;
    done = true;
    busy.n -= 1;
    if (!busy.n) { el.classList.add('d-none'); document.body.style.cursor = ''; }
  };
}

// POST an action; returns the reply, or null after showing the error.
async function invPost(body, done) {
  if (invPost.busy) { toast('Still working on the last change, one moment…', false); return null; }
  invPost.busy = true;
  const finish = busy(body && ['request', 'update', 'send', 'delete', 'import'].includes(body.action) ? 'Saving… (this can take up to a minute)' : 'Saving…');
  try {
    const res = await fetch('/api/client-invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    inv.config = data.config;
    inv.clients = data.clients;
    inv.drafts = data.drafts;
    inv.rowDrafts = data.rowDrafts || {};
    engModeInfo(data);
    renderDrafts();
    toast(data.notice || done);
    return data;
  } catch (e) {
    toast(e.message, false);
    return null;
  } finally {
    invPost.busy = false;
    finish();
  }
}

async function startAutomator(admin) {
  inv.admin = admin;
  document.querySelectorAll('.manage-only').forEach((el) => el.classList.remove('d-none'));
  if (admin) document.querySelectorAll('.admin-only').forEach((el) => el.classList.remove('d-none'));
  $id('templateFields').innerHTML = TEMPLATES.map((t) => `
    <div class="mb-3">
      <div class="d-flex justify-content-between align-items-end gap-2">
        <label class="form-label small fw-semibold mb-1" for="cfg-${t.key}">${t.label}</label>
        <button type="button" class="btn btn-light border btn-sm mb-1" onclick="previewTemplate('${t.key}')"><i class="fa-solid fa-eye me-1"></i>Preview</button>
      </div>
      <textarea id="cfg-${t.key}" class="form-control font-monospace" rows="4" style="font-size:12px"></textarea>
      <div class="form-text">Placeholders: ${t.vars.map((v) => `<code>{{${v}}}</code>`).join(' ')}</div>
    </div>`).join('');
  $id('manage-tab').addEventListener('shown.bs.tab', () => { if (!inv.rows.length) loadRows(); });
  const res = await fetch('/api/client-invoices');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || 'Could not load the automator settings', false);
  Object.assign(inv, { config: data.config, clients: data.clients, drafts: data.drafts, rowDrafts: data.rowDrafts || {} });
  engModeInfo(data);
  if (inv.rows.length) renderManage();
  renderClients();
  renderDrafts();
  fillConfig();
  if (admin) {
    $id('cfgScript').value = data.script || '';
    // the script that matches the current mode; the new (database) one is also shown for the move
    const fill = (code) => code.replace('__APP_URL__', location.origin).replace('__KEY__', data.key);
    const [sheetCode, dbCode] = await Promise.all(['InvoiceAutomatorSheet.gs', 'InvoiceAutomator.gs'].map((f) => fetch('/apps-script/' + f).then((r) => r.text()).catch(() => '')));
    $id('scriptCode').value = fill(data.dbMode ? dbCode : sheetCode);
    $id('dbScriptCode').value = fill(dbCode);
  }
}

/* ---------- Database mode ---------- */

// Mode-dependent wording and the admin's "Move to database" card.
function engModeInfo(data) {
  if (data.dbMode === undefined) return;
  inv.dbMode = data.dbMode;
  inv.sheetWaiting = data.sheetWaiting || 0;
  $id('manageIntro').innerHTML = inv.dbMode
    ? 'Invoices requested to the Finance Team. Add the invoice number and PDF link, then <b>Send to client</b>. Approving a reimbursement invoice adds its request\'s bills to the PDF from page 2. Reminders then go out by themselves at the configured intervals until you mark the payment received. Each change is copied to the sheet, which sends the emails.'
    : 'Rows of the sheet\'s Invoice Extracts tab. Add the invoice number and PDF link, then <b>Send to client</b>. Approving a reimbursement invoice adds its request\'s bills to the PDF from page 2. Reminders then go out by themselves at the configured intervals until you mark the payment received.';
  $id('dbTools').classList.toggle('d-none', !inv.dbMode);
  $id('resyncBtn').innerHTML = `<i class="fa-solid fa-arrows-rotate me-1"></i>Retry sheet sync${inv.sheetWaiting ? ` <span class="badge bg-danger">${inv.sheetWaiting}</span>` : ''}`;
  $id('rowSaveBtn').textContent = inv.dbMode ? 'Save' : 'Save to sheet';
  const box = $id('dbMoveState');
  if (box) box.innerHTML = inv.dbMode
    ? '<span class="badge bg-success-subtle text-success-emphasis border"><i class="fa-solid fa-database me-1"></i>Receivables are in the database</span> The sheet keeps the two tabs only for mailing.'
    : '<span class="badge bg-warning-subtle text-warning-emphasis border"><i class="fa-solid fa-table me-1"></i>Receivables still read from the sheet</span>';
  $id('dbMoveBtn').classList.toggle('d-none', inv.dbMode);
}

async function moveToDatabase() {
  if (!confirm('Copy the sheet\'s Invoice Extracts and RequestInvoice tabs into the database and switch Receivables to it?\n\nDo this right after pasting and deploying the new script.')) return;
  if (await invPost({ action: 'importSheet' }, 'Moved')) { inv.rows = []; loadData(); }
}
async function resyncSheet() { if (await invPost({ action: 'resync' }, 'Synced')) loadRows(); }
async function syncMail() { if (await invPost({ action: 'syncMail' }, 'Checked')) { loadRows(); loadData(); } }
const QUEUE_MODES = {
  sheet: ['Sheet timers', 'The sheet\'s timers read the two tabs and send, as before. The list below is what the queue would send.'],
  report: ['Sheet timers + queue report-only', 'The sheet\'s timers send; every hour the queue logs what it would have sent, compared below.'],
  app: ['Queue (app)', 'The script\'s hourly timer sends what the app says is due. The sheet tabs are not read for emails.'],
};
async function setQueueMode(sel) {
  const mode = sel.value;
  if (mode === 'app' && !confirm('Switch sending to the queue?\n\nPaste and deploy the latest script first (Automator Settings). From the next hourly run, Finance Team requests and reminders go out from the app\'s data, not the sheet.')) { toggleQueue(true); return; }
  await invPost({ action: 'queueMode', mode }, 'Saved');
  toggleQueue(true);
}
// Report-only check: what the queue would have sent against what the sheet's timers actually sent.
function queueCompare(d) {
  const c = d.compare || { rows: [], extra: [] };
  if (!c.rows.length && !c.extra.length) return d.mode === 'report' ? '<div class="small text-muted mt-3">Report-only comparison: nothing logged yet. The first entries appear after the next hourly run.</div>' : '';
  const what = (x) => (x.kind === 'request' ? 'Finance Team request' : `Reminder ${x.seq ?? '(no. from thread)'}`) + ` · #${x.refId}`;
  const M = { sent: ['Sent the same day or next', 'text-success', 'fa-check'], earlier: ['Already sent earlier', 'text-success', 'fa-check-double'],
    missing: ['Not sent by the sheet', 'text-danger', 'fa-triangle-exclamation'], 'not listed': ['Sent, but the queue did not list it', 'text-warning', 'fa-circle-question'] };
  const all = [...c.rows, ...c.extra];
  const bad = all.filter((x) => x.match === 'missing' || x.match === 'not listed').length;
  return `<details class="mt-3" ${bad ? 'open' : ''}><summary class="small fw-semibold">Report-only comparison, last 14 days: ${all.length - bad} agree, ${bad} to check</summary>
    <div class="table-responsive mt-2" style="max-height:14rem"><table class="table table-sm small mb-0"><thead class="bg-light"><tr><th>Queue day</th><th>Email</th><th>Result</th></tr></thead><tbody>
    ${all.map((x) => { const [n, cls, ic] = M[x.match]; return `<tr><td>${esc(x.day || '')}</td><td>${esc(what(x))}</td><td class="${cls}"><i class="fa-solid ${ic} me-1"></i>${n}${x.sentDay && x.match !== 'sent' ? ` (${esc(x.sentDay)})` : ''}</td></tr>`; }).join('')}
    </tbody></table></div><div class="small text-muted mt-1">Reminders with no number yet are expected under "Not sent by the sheet" when the thread already holds them; the script checks the thread before sending.</div></details>`;
}

// Email queue preview: what the database says is due now (the sheet's timers still do the sending) and the email log.
async function toggleQueue(force) {
  const box = $id('queueBox');
  if (!force && !box.classList.contains('d-none')) { box.classList.add('d-none'); return; }
  box.classList.remove('d-none');
  box.innerHTML = '<div class="filter-card p-3 small text-muted">Loading the email queue…</div>';
  try {
    const res = await fetch('/api/client-invoices?queue=1', { cache: 'no-store' });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'Could not read the email queue');
    const when = (at) => (at ? mailWhen(at) : '');
    const STATUS = { would_send: ['Would send', 'bg-info-subtle text-info-emphasis'], claimed: ['Claimed', 'bg-warning-subtle text-warning-emphasis'], sent: ['Sent', 'bg-success-subtle text-success-emphasis'],
      failed: ['Failed', 'bg-danger-subtle text-danger-emphasis'], skipped: ['Skipped', 'bg-light text-dark'], expired: ['Expired', 'bg-light text-muted'] };
    const SRC = { sheet: 'sheet timer', app: 'app', queue: 'queue' };
    box.innerHTML = `<div class="filter-card p-3">
      <div class="d-flex align-items-center gap-2 mb-2"><h2 class="h6 fw-bold mb-0 me-auto">Email queue <span class="text-muted fw-normal small">· as of ${esc(when(d.now))} (India time)</span></h2>
        <button class="btn btn-light border btn-sm py-0" onclick="toggleQueue(true)"><i class="fa-solid fa-rotate-right"></i></button>
        <button class="btn btn-light border btn-sm py-0" onclick="toggleQueue()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="d-flex flex-wrap align-items-center gap-2 mb-2 small">
        <span class="fw-semibold">Who sends the emails:</span>
        ${d.admin ? `<select class="form-select form-select-sm w-auto" onchange="setQueueMode(this)" aria-label="Who sends the emails">${Object.entries(QUEUE_MODES).map(([k, [n]]) => `<option value="${k}" ${k === d.mode ? 'selected' : ''}>${n}</option>`).join('')}</select>`
          : `<span class="badge bg-light text-dark border">${esc(QUEUE_MODES[d.mode][0])}</span>`}
        <span class="text-muted">${esc(QUEUE_MODES[d.mode][1])}</span></div>
      <div class="row g-3">
        <div class="col-lg-5"><div class="fw-semibold small mb-1">Due now (${d.jobs.length})</div>
          ${d.jobs.length ? `<ul class="list-unstyled small mb-0">${d.jobs.map((j) => `<li class="mb-1"><i class="fa-solid ${j.kind === 'request' ? 'fa-file-invoice' : 'fa-bell'} text-muted me-1"></i>${esc(j.label)}<div class="text-muted" style="font-size:.7rem">to ${esc([j.to, ...(j.cc || [])].join(', '))}</div></li>`).join('')}</ul>` : '<div class="small text-muted">Nothing due.</div>'}
          ${d.problems.length ? `<div class="fw-semibold small mt-2 mb-1 text-danger">Due but cannot go (${d.problems.length})</div><ul class="list-unstyled small mb-0">${d.problems.map((p) => `<li class="mb-1"><i class="fa-solid fa-triangle-exclamation text-danger me-1"></i>${esc(p.label)}: ${esc(p.problem)}</li>`).join('')}</ul>` : ''}</div>
        <div class="col-lg-7"><div class="fw-semibold small mb-1">Email log (latest ${d.log.length})</div>
          ${d.log.length ? `<div class="table-responsive" style="max-height:16rem"><table class="table table-sm small mb-0"><thead class="bg-light"><tr><th>When</th><th>Email</th><th>Status</th></tr></thead><tbody>${d.log.map((l) => {
            const [label, cls] = STATUS[l.status] || [l.status, 'bg-light'];
            const what = l.kind === 'request' ? 'Finance Team request' : l.kind === 'client' ? 'Invoice to client' : `Reminder ${l.seq ?? ''}`;
            return `<tr><td class="text-nowrap">${esc(when(l.at))}</td><td>${esc(what)} · ${esc(l.client || '')}${l.invoiceNumber ? ` · ${esc(l.invoiceNumber)}` : ''}${l.error ? `<div class="text-danger" style="font-size:.7rem">${esc(l.error)}</div>` : ''}</td>
              <td class="text-nowrap"><span class="badge ${cls}" style="font-size:10px">${esc(label)}</span> <span class="text-muted" style="font-size:.7rem">${esc(SRC[l.source] || '')}</span></td></tr>`;
          }).join('')}</tbody></table></div>` : '<div class="small text-muted">No emails logged yet. Emails sent from now on appear here.</div>'}</div>
      </div>${queueCompare(d)}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="filter-card p-3 small text-danger">${esc(e.message)}</div>`;
  }
}

async function compareDashboard() {
  const done = busy('Reading both…');
  try {
    const res = await fetch('/api/receivables?compare=1', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not compare');
    const rows = [['Total revenue', 'total', 'count'], ['Received', 'received', 'countReceived'], ['Receivables', 'pending', 'countPending'], ['Upcoming (excl. GST)', 'upcoming', 'countUpcoming']];
    $id('compareOut').innerHTML = `<table class="table table-sm small mb-1 mt-2"><thead><tr><th></th><th class="text-end">Database</th><th class="text-end">Sheet dashboard</th><th></th></tr></thead><tbody>`
      + rows.map(([label, k, c]) => {
        const same = data.sheet && Math.abs(data.db[k] - data.sheet[k]) < 0.01 && data.db[c] === data.sheet[c];
        return `<tr><td>${label}</td><td class="text-end">${formatINR(data.db[k])} (${data.db[c]})</td><td class="text-end">${data.sheet ? `${formatINR(data.sheet[k])} (${data.sheet[c]})` : '–'}</td>
          <td>${data.sheet ? (same ? '<i class="fa-solid fa-check text-success" title="Same"></i>' : '<i class="fa-solid fa-not-equal text-danger" title="Different"></i>') : ''}</td></tr>`;
      }).join('') + '</tbody></table>' + (data.sheetError ? `<div class="text-danger small">Sheet dashboard: ${esc(data.sheetError)}</div>` : '');
  } catch (e) {
    toast(e.message, false);
  } finally {
    done();
  }
}

/* ---------- Manage invoices ---------- */

async function loadRows() {
  $id('manageTable').innerHTML = `<tr><td class="text-muted py-4 text-center">${inv.dbMode ? 'Loading…' : 'Loading from the sheet…'}</td></tr>`;
  try {
    const res = await fetch('/api/client-invoices?rows=1', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read the sheet');
    inv.rows = data.rows || [];
    renderManage();
  } catch (e) {
    $id('manageTable').innerHTML = `<tr><td class="text-danger py-4">${esc(e.message)}</td></tr>`;
  }
}

// Manage Invoices tabs, one per stage; any other sheet status counts as a new entry.
const MANAGE_TABS = [['NEW_ENTRY', 'New entry'], ['APPROVED', 'Approved'], ['REMINDER', 'Reminders'], ['PAID', 'Payment received']];
const tabOf = (r) => { const s = r.status.toUpperCase(); return s === 'PAYMENT RECEIVED' ? 'PAID' : ['APPROVED', 'REMINDER'].includes(s) ? s : 'NEW_ENTRY'; };
// A reimbursement invoice goes to the client only once its bills are in the PDF (added when it is approved).
const billsPending = (r) => isReimbRow(r) && r.billCount > 0 && !r.billsAttached;

function showManageTab(key) { inv.manageTab = key; renderManage(); }

// Amount Receivable column: the sheet's "to be received" figure, else worked out from the amount with GST (blank until that is in).
const receivableOf = (r) => (r.toReceive > 0 ? r.toReceive : r.withGst > 0 ? toBeReceived(r.withGst, r.amount, isReimbRow(r)) : 0);

// Tiny email trail under the client: last email sent and the next one scheduled (database mode).
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mailWhen = (at) => (at ? `${Number(at.slice(8, 10))} ${MON[Number(at.slice(5, 7)) - 1]}${at.slice(0, 4) === String(new Date().getFullYear()) ? '' : ' ' + at.slice(0, 4)}, ${at.slice(11, 16)}` : '');
function mailLine(r) {
  const l = r.lastEmail, n = r.nextEmail;
  if (!l && !n) return '';
  const last = l ? `<span title="Last email: ${esc(l.what)}${l.at ? ' on ' + esc(mailWhen(l.at)) : ' (time not recorded)'}${l.approx ? ' (estimated from the reminder schedule)' : ''}"><i class="fa-solid fa-envelope-circle-check text-success me-1"></i>${l.at ? (l.approx ? '≈' : '') + esc(mailWhen(l.at)) : 'sent'} · ${esc(l.what)}</span>` : '';
  const next = n ? `<span title="Next email: ${esc(n.what)}${n.at ? ' around ' + esc(mailWhen(n.at)) : ''}"><i class="fa-regular fa-clock me-1"></i>${n.at ? esc(mailWhen(n.at)) + ' · ' : ''}${esc(n.what)}</span>` : '';
  return `<div class="mail-line">${last}${next}</div>`;
}

function renderManage() {
  const found = inv.rows.filter((r) => matches('manageSearch', isReimbRow(r) ? 'reimbursement' : 'service', rowDraftOf(r) ? 'draft' : '', r.client, r.invoiceNumber, r.invoiceDate, r.dueDate, r.amount, receivableOf(r) || ''));
  $id('manageTabs').innerHTML = MANAGE_TABS.map(([key, label]) => {
    const n = found.filter((r) => tabOf(r) === key).length;
    const on = key === inv.manageTab;
    return `<li class="nav-item" role="presentation"><button type="button" role="tab" aria-selected="${on}" class="nav-link py-1 px-3 ${on ? 'active' : ''}" onclick="showManageTab('${key}')">${label} <span class="badge rounded-pill ${on ? 'bg-white text-primary' : 'bg-light text-dark border'} ms-1">${n}</span></button></li>`;
  }).join('');
  const paidTab = inv.manageTab === 'PAID';
  // the next email due goes first; rows waiting to be sent by hand next, then the rest newest first
  const nextKey = (r) => (r.nextEmail ? (r.nextEmail.at ? '0' + r.nextEmail.at : '1') : '2');
  const list = found.filter((r) => tabOf(r) === inv.manageTab).slice().reverse()
    .map((r, i) => ({ r, i })).sort((a, b) => nextKey(a.r).localeCompare(nextKey(b.r)) || a.i - b.i).map((x) => x.r);
  if (!list.length) { $id('manageTable').innerHTML = `<tr><td class="text-muted py-4 text-center">${inv.rows.length ? 'No invoices here.' : 'No invoices to show.'}</td></tr>`; return; }
  $id('manageTable').innerHTML = `<thead class="bg-light"><tr><th>Client</th><th>Invoice Date</th><th class="text-end">Amount (w/o GST)</th><th class="text-end">Amount Receivable</th><th>${paidTab ? 'Received' : 'Due'}</th><th>PDF</th><th></th></tr></thead><tbody>`
    + list.map((r) => {
      const link = safeLink(r.pdfUrl);
      const reimb = isReimbRow(r);
      const ready = ['NEW_ENTRY', 'APPROVED'].includes(r.status.toUpperCase()) && r.invoiceNumber && link && r.withGst > 0 && !billsPending(r);
      const draft = rowDraftOf(r);
      return `<tr class="${reimb ? 'inv-reimb' : 'inv-service'}">
        <td style="white-space:normal;min-width:12rem">${esc(r.client)}
          <div class="d-flex align-items-center flex-wrap gap-2 mt-1">
            <span class="badge badge-soft ${reimb ? 'badge-type-reimb' : 'badge-type-service'}" style="font-size:10px">${reimb ? 'Reimbursement' : 'Service'}</span>
            ${r.invoiceNumber ? `<span class="inv-no">${esc(r.invoiceNumber)}</span>` : '<span class="inv-no text-muted fst-italic">No invoice no. yet</span>'}
            ${draft ? `<span class="badge badge-soft badge-soft-upcoming" style="font-size:10px" title="Draft by ${esc(draft.by)} on ${esc(draft.on)}, not saved yet"><i class="fa-solid fa-pen-ruler me-1"></i>Draft</span>` : ''}
            ${r.sheetError ? `<span class="badge bg-danger-subtle text-danger-emphasis border" style="font-size:10px" title="Not in the sheet yet: ${esc(r.sheetError)}"><i class="fa-solid fa-triangle-exclamation me-1"></i>Sheet copy failed</span>` : ''}
          </div>${mailLine(r)}</td>
        <td>${esc(r.invoiceDate)}</td>
        <td class="text-end">${formatINR(r.amount)}</td>
        <td class="text-end" title="${isReimbRow(r) ? 'Amount with GST (reimbursement, no TDS)' : 'Amount with GST − 10% TDS on the amount w/o GST'}">${receivableOf(r) ? formatINR(receivableOf(r)) : '<span class="text-muted" title="Add the amount with GST to see this">-</span>'}</td>
        <td>${esc(paidTab ? r.receivedDate || '-' : r.dueDate)}</td>
        <td>${link ? `<button type="button" class="btn btn-light border btn-sm" onclick="previewPdf(${rkey(r)})"><i class="fa-solid fa-file-pdf"></i> PDF</button>` : '<span class="text-muted">-</span>'}
          ${reimb && r.billCount ? `<div class="inv-no mt-1 ${r.billsAttached ? 'text-success' : 'text-muted'}"><i class="fa-solid fa-paperclip me-1"></i>${r.billCount} bill${r.billCount > 1 ? 's' : ''}${r.billsAttached ? ' included' : ' (added on approval)'}</div>` : ''}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-light border btn-sm" onclick="openRow(${rkey(r)})"><i class="fa-solid fa-pen"></i> Update</button>
          ${ready ? `<button class="btn btn-primary btn-sm" onclick="sendToClient(${rkey(r)})"><i class="fa-solid fa-envelope"></i> Send to client</button>` : ''}
          ${r.status.toUpperCase() === 'NEW_ENTRY' ? `<button class="btn btn-outline-danger btn-sm" onclick="deleteRow(${rkey(r)})" title="Delete this new entry" aria-label="Delete invoice for ${esc(r.client)}"><i class="fa-solid fa-trash"></i></button>` : ''}
        </td></tr>`;
    }).join('') + '</tbody>';
}

// Shows an invoice PDF in a dialog (dashboard tabs and Manage Invoices, every role that sees the page).
// Drive files use Drive's embeddable viewer, so the viewer must have access to the file.
function openPdf(url, title) {
  const link = safeLink(url);
  if (!link) return;
  const id = (link.match(/\/d\/([-\w]{25,})/) || link.match(/[?&]id=([-\w]{25,})/) || [])[1];
  $id('pdfTitle').innerText = title;
  $id('pdfFrame').src = id ? `https://drive.google.com/file/d/${id}/preview` : link;
  $id('pdfOpen').href = link;
  modal('pdfModal').show();
}
$id('pdfModal').addEventListener('hidden.bs.modal', () => { $id('pdfFrame').src = 'about:blank'; }); // stop loading once closed

function previewPdf(key) {
  const r = rowByKey(key);
  openPdf(r.pdfUrl, `Invoice ${r.invoiceNumber || ''} · ${r.client}`);
}

let editingRow = null;
function openRow(key) {
  editingRow = rowByKey(key);
  const d = rowDraftOf(editingRow); // a saved draft takes the place of the sheet's values
  $id('rowInfo').innerText = `${editingRow.client} · invoice date ${editingRow.invoiceDate} · ${formatINR(editingRow.amount)}`;
  $id('rwDraftNote').classList.toggle('d-none', !d);
  if (d) $id('rwDraftBy').innerText = `${d.by} on ${d.on}`;
  // database mode: the invoice date can change while the invoice is a new entry
  const dateEditable = inv.dbMode && editingRow.status.toUpperCase() === 'NEW_ENTRY';
  $id('rwDateBox').classList.toggle('d-none', !dateEditable);
  $id('rwDate').value = editingRow.invoiceDateIso || '';
  $id('rwNumber').value = d ? d.invoiceNumber : editingRow.invoiceNumber;
  $id('rwPdf').value = d ? d.pdfUrl : editingRow.pdfUrl;
  $id('rwGst').value = (d ? d.withGst : editingRow.withGst) || '';
  $id('rwStatus').value = d ? d.status : Object.keys(ROW_STATUS).find((s) => s.toLowerCase() === editingRow.status.toLowerCase()) || 'NEW_ENTRY';
  $id('rwReceived').value = (d && d.receivedDate) || editingRow.receivedDateIso || localToday();
  toggleReceived();
  rowReadiness();
  rowBills();
  modal('rowModal').show();
}

// Approved / Emailed need the invoice number, the PDF link and the amount with GST (checked again on the server).
const NEEDS_DETAILS = ['APPROVED', 'REMINDER'];
// Preview only; the sheet script saves the same figure from the row's own amount (keep in step with iyToBeReceived_).
// Reimbursement invoices carry no TDS: the amount to be received is the amount with GST.
const toBeReceived = (withGst, withoutGst, reimb) => Math.round((reimb ? withGst : withGst - 0.1 * withoutGst) * 100) / 100;
const DRIVE_LINK = /^https:\/\/(drive|docs)\.google\.com\/.*[-\w]{25,}/;
function rowMissing() {
  return [
    !$id('rwNumber').value.trim() && 'invoice number',
    !DRIVE_LINK.test($id('rwPdf').value.trim()) && 'invoice PDF Google Drive link',
    !(Number($id('rwGst').value) > 0) && 'amount with GST',
  ].filter(Boolean);
}
function rowReadiness() {
  const gst = Number($id('rwGst').value);
  const reimb = isReimbRow(editingRow);
  $id('rwFormula').innerHTML = reimb ? '= amount with GST (reimbursement invoice, no TDS)'
    : `= amount with GST − 10% TDS on <span id="rwBase">${formatINR(editingRow.amount)}</span> (amount w/o GST)`;
  const calc = gst > 0 ? toBeReceived(gst, editingRow.amount, reimb) : 0;
  // Opened unchanged: show what the sheet holds, and flag it if saving would change it.
  const sheet = gst > 0 && gst === editingRow.withGst ? editingRow.toReceive : 0;
  $id('rwToReceive').innerText = gst > 0 ? formatINR(calc) : '-';
  $id('rwSheetNote').innerText = sheet && Math.abs(sheet - calc) > 0.005 ? ` It is now ${formatINR(sheet)}; saving replaces it.` : '';
  const missing = rowMissing();
  const sel = $id('rwStatus');
  [...sel.options].forEach((o) => { if (NEEDS_DETAILS.includes(o.value)) o.disabled = missing.length > 0 && o.value !== sel.value; });
  $id('rwReadyHint').classList.toggle('d-none', !missing.length);
  $id('rwReadyHint').innerText = `To choose Approved or Emailed, add the ${missing.join(', ')}.`;
  $id('rwReadyHint').classList.toggle('text-danger', missing.length > 0 && NEEDS_DETAILS.includes(sel.value));
}

// Approving a reimbursement invoice adds its request's bills to the PDF from page 2 (done on Save to sheet).
function rowBills() {
  const r = editingRow;
  const show = isReimbRow(r) && $id('rwStatus').value === 'APPROVED';
  $id('rwBillsBox').classList.toggle('d-none', !show);
  if (!show) return;
  const n = r.billCount || 0;
  const already = r.billsAttached && $id('rwPdf').value.trim() === r.pdfUrl;
  $id('rwBills').disabled = !n;
  $id('rwBills').checked = n > 0 && !already;
  $id('rwBillsLabel').innerText = !n ? 'No bills were found for this reimbursement request, so the PDF stays as it is.'
    : already ? `The ${n} bill${n > 1 ? 's are' : ' is'} already in the invoice PDF. Tick to rebuild it from the original invoice with the bills.`
    : `Add the request's ${n} bill${n > 1 ? 's' : ''} to the invoice PDF from page 2 (a new PDF is saved next to the invoice in Drive).`;
}

function toggleReceived() {
  const paid = $id('rwStatus').value === 'Payment Received';
  $id('rwReceivedBox').classList.toggle('d-none', !paid);
  $id('rwReceived').required = paid;
}

async function saveRow(e) {
  e.preventDefault();
  const missing = rowMissing();
  if (NEEDS_DETAILS.includes($id('rwStatus').value) && missing.length) return toast(`Add the ${missing.join(', ')} before choosing this status`, false);
  const btn = e.submitter;
  btn.disabled = true;
  const attach = !$id('rwBillsBox').classList.contains('d-none') && $id('rwBills').checked;
  if (attach) btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Adding the bills…';
  const ok = await invPost({ action: 'update', update: { ...rowForm(), attachBills: attach, rebuildBills: attach && editingRow.billsAttached } }, 'Saved');
  btn.innerText = inv.dbMode ? 'Save' : 'Save to sheet';
  btn.disabled = false;
  if (ok) { modal('rowModal').hide(); loadRows(); loadData(); }
}

const rowForm = () => ({ row: editingRow.row, id: editingRow.id, client: editingRow.client, invoiceDateIso: editingRow.invoiceDateIso || '', invoiceNumber: $id('rwNumber').value,
  pdfUrl: $id('rwPdf').value, withGst: $id('rwGst').value, status: $id('rwStatus').value, receivedDate: $id('rwReceived').value,
  ...(!$id('rwDateBox').classList.contains('d-none') && $id('rwDate').value ? { invoiceDate: $id('rwDate').value } : {}) });

// Keeps what is filled in so far in the app only; the sheet row is untouched until Save to sheet.
async function saveRowDraft(btn) {
  btn.disabled = true;
  const ok = await invPost({ action: 'rowDraft', update: rowForm() }, 'Draft saved');
  btn.disabled = false;
  if (ok) { modal('rowModal').hide(); if (inv.dbMode) loadRows(); else renderManage(); }
}

async function discardRowDraft() {
  if (!confirm('Discard this draft? The form goes back to what the sheet has.')) return;
  if (await invPost({ action: 'deleteRowDraft', update: rowForm() }, 'Draft discarded')) { if (inv.dbMode) await loadRows(); else renderManage(); openRow(rkey(editingRow)); }
}

// New entries only: removes the row from the sheet (and its request, if the Finance Team hasn't been emailed yet).
async function deleteRow(key) {
  const r = rowByKey(key);
  if (!confirm(`Delete the new entry for ${r.client} (invoice date ${r.invoiceDate}, ${formatINR(r.amount)})?\n\nIt is removed${inv.dbMode ? '' : " from the sheet's Invoice Extracts tab"}. This can't be undone.`)) return;
  if (await invPost({ action: 'delete', update: { row: r.row, id: r.id, client: r.client, invoiceDateIso: r.invoiceDateIso || '' } }, 'Deleted')) { loadRows(); loadData(); }
}

async function sendToClient(key) {
  const r = rowByKey(key);
  const c = inv.clients.find((x) => x.name.toLowerCase() === r.client.toLowerCase());
  if (!confirm(`Email invoice ${r.invoiceNumber} to ${r.client}${c ? ` (${c.emails})` : ''} with the PDF attached?`)) return;
  if (await invPost({ action: 'send', row: r.row, id: r.id, client: r.client }, 'Sent')) { loadRows(); loadData(); }
}

/* ---------- Request invoice ---------- */
// Reimbursement types are built row by row (one bill per row) and can be kept pending until every bill is in.

const isReimb = (type) => /reimburs/i.test(type || '');
let rq = { draftId: null, items: [] };
const blankRow = () => ({ date: localToday(), particulars: '', amount: '', link: '' });

function openRequest(draftId) {
  const draft = draftId ? inv.drafts.find((d) => d.id === draftId) : null;
  $id('rqType').innerHTML = inv.config.invoiceTypes.map((t) => `<option>${esc(t)}</option>`).join('');
  ['rqClient', 'rqPo', 'rqDesc', 'rqAmount', 'rqAttach'].forEach((id) => ($id(id).value = ''));
  $id('rqDate').value = localToday();
  $id('rqNow').checked = false;
  rq = { draftId: null, items: [blankRow()] };
  if (draft) {
    $id('rqType').value = draft.invoiceType;
    $id('rqClient').value = draft.client;
    loadDraft(draft);
  } else showDraftState();
  requestTypeChanged();
  modal('requestModal').show();
}

function loadDraft(draft) {
  rq = { draftId: draft.id, items: draft.items.map((it) => ({ ...it })) };
  $id('rqPo').value = draft.poNumber;
  showDraftState(`Continuing the pending request for ${draft.client} (saved ${draft.updatedOn}). Add rows, then save or submit.`);
}

function showDraftState(note) {
  $id('rqDraftNote').innerText = note || '';
  $id('rqDraftNote').classList.toggle('d-none', !note);
  $id('rqClient').disabled = Boolean(rq.draftId); // a pending request belongs to its client
  $id('rqDelete').classList.toggle('d-none', !rq.draftId);
}

function requestTypeChanged() {
  const reimb = isReimb($id('rqType').value);
  $id('rqSingle').classList.toggle('d-none', reimb);
  $id('rqRows').classList.toggle('d-none', !reimb);
  $id('rqSaveDraft').classList.toggle('d-none', !reimb);
  $id('rqDesc').required = !reimb;
  $id('rqAmount').required = !reimb;
  if (reimb) { requestClientChanged(); renderRequestRows(); }
}

// Client picker: type to filter (any part of the name), arrows + Enter, or click. Clients on hold are left out.
let clientShown = [], clientActive = -1;
function openClientList(all) {
  if ($id('rqClient').disabled) return;
  const q = all ? '' : $id('rqClient').value.trim().toLowerCase();
  clientShown = inv.clients.filter((c) => !c.onHold && (!q || c.name.toLowerCase().includes(q)));
  clientActive = clientShown.length ? 0 : -1;
  renderClientList();
}
function renderClientList() {
  const list = $id('rqClients');
  list.innerHTML = clientShown.length
    ? clientShown.map((c, i) => `<li id="client-opt-${c.id}" role="option" aria-selected="${i === clientActive}" onmousedown="event.preventDefault(); chooseClient(${c.id})">${esc(c.name)}</li>`).join('')
    : '<li class="empty">No matching client</li>';
  list.classList.remove('d-none');
  $id('rqClient').setAttribute('aria-expanded', 'true');
  $id('rqClient').setAttribute('aria-activedescendant', clientActive >= 0 ? `client-opt-${clientShown[clientActive].id}` : '');
  const on = list.querySelector('[aria-selected="true"]');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function closeClientList() {
  $id('rqClients').classList.add('d-none');
  $id('rqClient').setAttribute('aria-expanded', 'false');
  requestClientChanged(); // a typed full name also continues a pending request
}
function toggleClientList() {
  if ($id('rqClients').classList.contains('d-none')) { $id('rqClient').focus(); openClientList(true); } else closeClientList();
}
function clientListKey(e) {
  const open = !$id('rqClients').classList.contains('d-none');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) return openClientList(true);
    if (!clientShown.length) return;
    clientActive = (clientActive + (e.key === 'ArrowDown' ? 1 : -1) + clientShown.length) % clientShown.length;
    renderClientList();
  } else if (e.key === 'Enter') {
    e.preventDefault(); // don't submit the form
    if (open && clientActive >= 0) chooseClient(clientShown[clientActive].id);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault(); e.stopPropagation(); // close the list, not the dialog
    closeClientList();
  }
}
function chooseClient(id) {
  $id('rqClient').value = inv.clients.find((c) => c.id === id).name;
  closeClientList();
  requestClientChanged();
}

// Picking a client with a pending reimbursement request continues that request.
function requestClientChanged() {
  if (rq.draftId || !isReimb($id('rqType').value)) return;
  const draft = inv.drafts.find((d) => d.client.toLowerCase() === $id('rqClient').value.trim().toLowerCase());
  if (draft) { $id('rqType').value = draft.invoiceType; loadDraft(draft); renderRequestRows(); }
}

function renderRequestRows() {
  $id('rqItems').innerHTML = `<thead><tr><th style="width:2rem">#</th><th style="width:6.5rem">Added</th><th>Particulars</th><th style="width:9rem">Amount (₹)</th><th>Bill (Google Drive link, optional)</th><th style="width:2rem"></th></tr></thead><tbody>`
    + rq.items.map((it, n) => `<tr>
      <td class="text-muted">${n + 1}</td>
      <td class="text-muted small">${esc(it.date.split('-').reverse().join('/'))}</td>
      <td><input class="form-control form-control-sm" required maxlength="300" aria-label="Particulars, row ${n + 1}" value="${esc(it.particulars)}" oninput="rq.items[${n}].particulars = this.value"></td>
      <td><input class="form-control form-control-sm text-end" required type="number" min="0.01" step="0.01" aria-label="Amount, row ${n + 1}" value="${esc(it.amount)}" oninput="rq.items[${n}].amount = this.value; requestTotal()"></td>
      <td><input class="form-control form-control-sm" type="url" maxlength="500" placeholder="https://drive.google.com/file/d/…" aria-label="Bill link, row ${n + 1}" value="${esc(it.link)}" oninput="rq.items[${n}].link = this.value"></td>
      <td>${rq.items.length > 1 ? `<button type="button" class="btn btn-light border btn-sm" onclick="rq.items.splice(${n}, 1); renderRequestRows()" aria-label="Remove row ${n + 1}"><i class="fa-solid fa-trash"></i></button>` : ''}</td>
    </tr>`).join('') + '</tbody>';
  requestTotal();
}

function addRequestRow() {
  rq.items.push(blankRow());
  renderRequestRows();
  $id('rqItems').querySelector('tbody tr:last-child input').focus();
}

function requestTotal() {
  $id('rqTotal').innerText = formatINR(rq.items.reduce((s, it) => s + (Number(it.amount) || 0), 0));
}

function requestBody() {
  const client = inv.clients.find((c) => c.name.toLowerCase() === $id('rqClient').value.trim().toLowerCase());
  if (!client) { toast('Pick a client from the list (add new clients in the Clients tab)', false); return null; }
  const base = { invoiceType: $id('rqType').value, client: client.name, invoiceDate: $id('rqDate').value, poNumber: $id('rqPo').value, sendNow: $id('rqNow').checked };
  if (!isReimb(base.invoiceType)) return { ...base, description: $id('rqDesc').value, amount: $id('rqAmount').value, attachmentUrl: $id('rqAttach').value };
  return { ...base, draftId: rq.draftId, items: rq.items.map((it) => ({ ...it, amount: Number(it.amount) })) };
}

function requestDone() {
  modal('requestModal').hide();
  loadData();
  if ($id('manage-tab').classList.contains('active')) loadRows(); else inv.rows = [];
}

async function submitRequest(e) {
  e.preventDefault();
  const request = requestBody();
  if (!request) return;
  const btn = e.submitter;
  btn.disabled = true;
  const ok = await invPost({ action: 'request', request }, 'Requested');
  btn.disabled = false;
  if (ok) requestDone();
}

async function saveDraftRequest() {
  if (!$id('requestModal').querySelector('form').reportValidity()) return;
  const request = requestBody();
  if (request && await invPost({ action: 'draft', request }, 'Saved as pending')) modal('requestModal').hide();
}

async function deleteDraft() {
  if (!confirm('Delete this pending request and all its rows?')) return;
  if (await invPost({ action: 'deleteDraft', id: rq.draftId }, 'Deleted')) modal('requestModal').hide();
}

function renderDrafts() {
  const box = $id('draftsBox');
  box.classList.toggle('d-none', !inv.drafts.length);
  box.innerHTML = !inv.drafts.length ? '' : `<div class="fw-semibold small mb-1"><i class="fa-solid fa-hourglass-half"></i> Pending reimbursement requests (not yet sent to the Finance Team)</div>
    <table class="table align-middle mb-0 small"><tbody>${inv.drafts.map((d) => `<tr>
      <td style="white-space:normal">${esc(d.client)}</td><td>${d.items.length} row(s)</td>
      <td class="text-end">${formatINR(d.items.reduce((s, it) => s + it.amount, 0))}</td><td class="text-muted">Saved ${esc(d.updatedOn)}</td>
      <td class="text-end"><button class="btn btn-primary btn-sm" onclick="openRequest(${d.id})"><i class="fa-solid fa-pen"></i> Continue</button></td></tr>`).join('')}</tbody></table>`;
}

/* ---------- Clients ---------- */

function renderClients() {
  const list = inv.clients.filter((c) => matches('clientSearch', c.name, c.emails, c.contact, c.onHold ? 'on hold' : 'active'));
  $id('clientsTable').innerHTML = !inv.clients.length
    ? '<tr><td class="text-muted py-4 text-center">No clients yet. The admin can import them from the sheet (Automator Settings).</td></tr>'
    : !list.length ? '<tr><td class="text-muted py-4 text-center">No clients match your search.</td></tr>'
    : `<thead class="bg-light"><tr><th>Client</th><th>Emails</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>`
      + list.map((c) => `<tr>
        <td class="fw-semibold" style="white-space:normal">${esc(c.name)}</td>
        <td style="white-space:normal;word-break:break-word">${esc(c.emails)}</td>
        <td>${esc(c.contact)}</td>
        <td>${c.onHold ? '<span class="badge badge-soft badge-soft-overdue">On hold</span>' : '<span class="badge badge-soft badge-soft-received">Active</span>'}</td>
        <td class="text-end"><button class="btn btn-light border btn-sm" onclick="openClient(${c.id})"><i class="fa-solid fa-pen"></i> Edit</button></td></tr>`).join('') + '</tbody>';
}

let editingClient = null;
function openClient(id) {
  editingClient = id ? inv.clients.find((c) => c.id === id) : null;
  $id('clientTitle').innerText = editingClient ? 'Edit client' : 'Add client';
  $id('clName').value = editingClient ? editingClient.name : '';
  $id('clName').disabled = Boolean(editingClient);
  $id('clEmails').value = editingClient ? editingClient.emails : '';
  $id('clContact').value = editingClient ? editingClient.contact : '';
  $id('clHold').checked = Boolean(editingClient && editingClient.onHold);
  modal('clientModal').show();
}

async function saveClient(e) {
  e.preventDefault();
  const ok = await invPost({ action: 'client', client: { id: editingClient?.id, name: $id('clName').value, emails: $id('clEmails').value, contact: $id('clContact').value, onHold: $id('clHold').checked } }, 'Client saved');
  if (ok) { modal('clientModal').hide(); renderClients(); }
}

/* ---------- Settings ---------- */

function fillConfig() {
  const c = inv.config;
  $id('cfgFinance').value = c.financeEmails;
  $id('cfgDays').value = c.requestDaysBefore;
  $id('cfgTime').value = c.requestTime;
  $id('cfgTypes').value = c.invoiceTypes.join(', ');
  $id('cfgIntervals').value = c.reminderIntervals.join(', ');
  TEMPLATES.forEach((t) => ($id(`cfg-${t.key}`).value = c[t.key] || ''));
}

async function saveConfig(e) {
  e.preventDefault();
  const config = {
    financeEmails: $id('cfgFinance').value, requestDaysBefore: Number($id('cfgDays').value), requestTime: $id('cfgTime').value,
    invoiceTypes: $id('cfgTypes').value, reminderIntervals: $id('cfgIntervals').value,
    ...Object.fromEntries(TEMPLATES.map((t) => [t.key, $id(`cfg-${t.key}`).value])),
  };
  if (await invPost({ action: 'config', config }, 'Settings saved')) fillConfig();
}

function previewTemplate(key) {
  const html = Object.entries(SAMPLE).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(esc(v)), $id(`cfg-${key}`).value || '<p>(empty template)</p>');
  $id('previewFrame').srcdoc = html; // sandboxed: no scripts run
  modal('previewModal').show();
}

async function saveScript(e) {
  e.preventDefault();
  if (await invPost({ action: 'script', script: $id('cfgScript').value }, 'Sheet link saved')) inv.rows = [];
}

async function importSheet() {
  if (!confirm('Copy the sheet\'s Config and ClientList tabs into the webapp? Settings here are replaced; clients already here are kept.')) return;
  if (await invPost({ action: 'import' }, 'Imported')) { renderClients(); fillConfig(); }
}

function copyCode() {
  navigator.clipboard.writeText($id('scriptCode').value).then(() => toast('Code copied'), () => toast('Select the code and copy it', false));
}
