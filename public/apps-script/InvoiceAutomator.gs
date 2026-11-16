// Invincible YOU · Client Invoice Automator (database version). The webapp's database holds the invoices; this
// sheet keeps two tabs only, as the mailing queue: "Invoice Extracts" (emails to clients) and "RequestInvoice"
// (emails to the Finance Team). Each row carries the webapp record's id in an AppId column.
// The webapp calls doPost() to write rows and send; iyRequestEmails and iyReminders run on timers
// (run iyInstallTriggers once) and tell the webapp what they emailed.
// Email queue: the webapp's "Who sends the emails" setting decides what the timers do.
//   sheet / report  the timers read the two tabs as before (report: the webapp also logs what its queue would send)
//   app             the hourly timer asks the webapp for the emails due and sends them; the tabs are not read
const APP_URL = '__APP_URL__';
const APP_KEY = '__KEY__';
const REMINDER_TAG = 'GAS_INV_REMINDER';
const REMINDER_MARKER = '<span style="display:none;" class="gas-inv-reminder-tag">' + REMINDER_TAG + '</span>';
const EXTRACTS = 'Invoice Extracts';
const REQUESTS = 'RequestInvoice';

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.key !== APP_KEY) return out({ error: 'Wrong key: copy the script again from Receivables, Automator Settings' });
    if (b.action === 'dump') return out(iyDump_());
    if (b.action === 'mailStatus') return out(iyMailStatus_());
    // Writes and emails one at a time, so a double click can't send twice.
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return out({ error: 'The sheet is busy, please try again in a minute' });
    try {
      if (b.action === 'stamp') return out(iyStamp_(b));
      if (b.action === 'putExtract') { iyPut_(EXTRACTS, b.row); return out({ ok: true }); }
      if (b.action === 'putRequest') return out(iyPutRequest_(b));
      if (b.action === 'deleteExtract') return out({ deleted: iyDeleteRow_(EXTRACTS, b.id) });
      if (b.action === 'deleteRequest') return out({ deleted: iyDeleteRow_(REQUESTS, b.id) });
      if (b.action === 'send') return out(iySendClient_(b));
      if (b.action === 'bills') return out(iyBillFiles_(b));
      if (b.action === 'saveMerged') return out(iySaveMerged_(b));
      if (b.action === 'sendJobs') return out({ results: (b.jobs || []).map(iySendJob_) });
    } finally {
      lock.releaseLock();
    }
    return out({ error: 'Unknown action' });
  } catch (err) {
    return out({ error: String(err.message || err) });
  }
}

/* ---------- shared helpers ---------- */

const iyKey_ = (s) => String(s || '').trim().toLowerCase();
const iyNorm_ = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
const iyTz_ = () => SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
const iyFmt_ = (d) => (d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, iyTz_(), 'dd/MM/yyyy') : String(d || ''));
const iyIso_ = (d) => (d instanceof Date && !isNaN(d) ? Utilities.formatDate(d, iyTz_(), 'yyyy-MM-dd') : '');
const iyFileId_ = (url) => (String(url || '').match(/[-\w]{25,}/) || [])[0] || null;
const iyEsc_ = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iyRupees_ = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// A money cell as a number, or null when empty / not a number.
function iyNumOrNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.-]+/g, ''));
  return isNaN(n) || String(v).trim() === '' ? null : n;
}

// 'YYYY-MM-DD' -> Date at midnight in the script's time zone; Date or 'dd/mm/yyyy' cells too.
function iyDate_(v) {
  if (v instanceof Date) { const d = new Date(v.getTime()); d.setHours(0, 0, 0, 0); return d; }
  let m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}

// Settings and the client list from the webapp. Throws (so nothing is sent) if the webapp can't be reached.
function iySetup_() {
  const res = UrlFetchApp.fetch(APP_URL + '/api/client-invoices?key=' + encodeURIComponent(APP_KEY), { muteHttpExceptions: true });
  let out = {};
  try { out = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200) throw new Error('Webapp settings unavailable: ' + (out.error || 'HTTP ' + res.getResponseCode()));
  const clients = {};
  (out.clients || []).forEach((c) => {
    const emails = String(c.emails || '').split(/[;,\s]+/).filter(Boolean);
    clients[iyKey_(c.name)] = { name: c.name, primaryEmail: emails[0] || '', ccEmails: emails.slice(1), contactPoint: c.contact || '', onHold: c.onHold };
  });
  return { config: out.config, clients: clients, emailQueue: out.emailQueue || 'sheet' };
}

// POST to the webapp with the key; throws when it can't be reached.
function iyPost_(payload) {
  const res = UrlFetchApp.fetch(APP_URL + '/api/client-invoices', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify(Object.assign({ key: APP_KEY }, payload)),
  });
  let out = {};
  try { out = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200) throw new Error('Webapp: ' + (out.error || 'HTTP ' + res.getResponseCode()));
  return out;
}

// Tells the webapp what a timer emailed (so its records stay right). A failure is only logged: the webapp's
// "Check emails sent" reads the sheet again.
function iyTell_(payload) {
  try {
    const res = UrlFetchApp.fetch(APP_URL + '/api/client-invoices', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify(Object.assign({ key: APP_KEY, action: 'mailed' }, payload)),
    });
    if (res.getResponseCode() !== 200) Logger.log('Webapp not told (' + res.getResponseCode() + '): ' + res.getContentText());
  } catch (err) {
    Logger.log('Webapp not told: ' + err.message);
  }
}

/* ---------- the two tabs ---------- */

// Each field: [webapp name, sheet header, kind]. Kinds: text, num, date. Headers are matched loosely
// (case, spaces and punctuation ignored); a missing column is added at the end of the header row when first written.
const EXTRACT_FIELDS = [
  ['client', 'Client', 'text'], ['invoiceNumber', 'Invoice number', 'text'], ['invoiceDate', 'Invoice Date', 'date'], ['category', 'Category', 'text'],
  ['amount', 'Amount(w/o GST)', 'num'], ['withGst', 'Amt(withGST)', 'num'], ['toReceive', 'Amt(ToBeReceived)', 'num'], ['dueDate', 'Due Date', 'date'],
  ['pdfUrl', 'Invoice', 'text'], ['status', 'PaymentStatus', 'text'], ['thread', 'ClientEmailThread', 'text'], ['invoiceType', 'InvoiceType', 'text'],
  ['receivedDate', 'PymntRcvdDate', 'date'], ['bills', 'Bills', 'text'], ['noBills', 'Invoice Without Bills', 'text'], ['withBills', 'Invoice With Bills', 'text'],
];
const REQUEST_FIELDS = [
  ['invoiceType', 'InvoiceType', 'text'], ['client', 'Client', 'text'], ['category', 'Category', 'text'], ['invoiceDate', 'InvoiceDate', 'date'],
  ['description', 'Item&Description', 'text'], ['poNumber', 'PO_Number', 'text'], ['amount', 'AmountwithoutGST', 'num'], ['emailStatus', 'Email Status', 'text'],
  ['attachments', 'Attachment', 'text'],
];
const iyFields_ = (tab) => (tab === EXTRACTS ? EXTRACT_FIELDS : REQUEST_FIELDS);

function iyTab_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found in the sheet');
  const headers = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(iyNorm_);
  return { sh: sh, headers: headers, col: (h) => headers.indexOf(iyNorm_(h)) };
}

// Column of a header, added at the end of the header row if the tab doesn't have it yet.
function iyCol_(t, header) {
  let i = t.col(header);
  if (i === -1) {
    i = t.headers.length;
    t.sh.getRange(1, i + 1).setValue(header);
    t.headers.push(iyNorm_(header));
  }
  return i;
}

// Sheet row of a webapp id (0 when not in the sheet).
function iyFind_(t, id) {
  const c = t.col('AppId');
  if (c === -1 || !id) return 0;
  const last = t.sh.getLastRow();
  if (last < 2) return 0;
  const ids = t.sh.getRange(2, c + 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

// Writes a webapp record into its row (found by AppId, else a new row at the end). Other columns are left alone.
function iyPut_(tab, row) {
  if (!row || !row.id) throw new Error('Missing record id');
  const t = iyTab_(tab);
  const idCol = iyCol_(t, 'AppId');
  const cols = iyFields_(tab).map((f) => iyCol_(t, f[1]));
  let r = iyFind_(t, row.id);
  if (!r) {
    r = t.sh.getLastRow() + 1;
    t.sh.getRange(r, idCol + 1).setValue(row.id);
  }
  iyFields_(tab).forEach((f, i) => {
    if (!(f[0] in row)) return;
    const cell = t.sh.getRange(r, cols[i] + 1);
    const v = row[f[0]];
    if (f[2] === 'date') { const d = iyDate_(v); cell.setValue(d || ''); if (d) cell.setNumberFormat('dd/mm/yyyy'); }
    else if (f[2] === 'num') { cell.setValue(v === null || v === '' || v === undefined ? '' : Number(v)); if (v !== null && v !== '') cell.setNumberFormat('₹#,##0.00'); }
    else cell.setValue(v == null ? '' : String(v));
  });
  return r;
}

function iyDeleteRow_(tab, id) {
  const t = iyTab_(tab);
  const r = iyFind_(t, id);
  if (r) t.sh.deleteRow(r);
  return Boolean(r);
}

// A row as the webapp's record (for the one-time import and mail checks).
function iyRead_(t, values, tab) {
  const rec = {};
  iyFields_(tab).forEach((f) => {
    const c = t.col(f[1]);
    const v = c === -1 ? '' : values[c];
    rec[f[0]] = f[2] === 'date' ? iyIso_(iyDate_(v)) : f[2] === 'num' ? iyNumOrNull_(v) : String(v == null ? '' : v).trim();
  });
  // any other named columns are kept as they are
  const known = iyFields_(tab).map((f) => iyNorm_(f[1])).concat(['appid']);
  const extra = {};
  t.headers.forEach((h, i) => { if (h && known.indexOf(h) === -1 && String(values[i]).trim() !== '') extra[h] = String(values[i] instanceof Date ? iyFmt_(values[i]) : values[i]); });
  const blankHeaders = t.headers.map((h, i) => (!h && String(values[i]).trim() !== '' ? String(values[i]) : null)).filter((x) => x !== null);
  if (blankHeaders.length) extra._unnamed = blankHeaders.join(' ');
  rec.extra = extra;
  const idc = t.col('AppId');
  rec.appId = idc === -1 ? '' : String(values[idc] || '').trim();
  return rec;
}

/* ---------- webapp actions ---------- */

// Every row of both tabs, for the one-time copy into the webapp.
function iyDump_() {
  const out = {};
  [[EXTRACTS, 'extracts'], [REQUESTS, 'requests']].forEach(([tab, key]) => {
    const t = iyTab_(tab);
    const data = t.sh.getDataRange().getValues();
    out[key] = [];
    for (let i = 1; i < data.length; i++) {
      if (!String(data[i][t.col('Client')] || '').trim()) continue;
      const rec = iyRead_(t, data[i], tab);
      rec.row = i + 1;
      out[key].push(rec);
    }
  });
  return out;
}

// Writes the webapp ids into the AppId column after the import. Every row is checked (still the same client)
// before anything is written, so a changed sheet stamps nothing.
function iyStamp_(b) {
  const jobs = [[EXTRACTS, b.extracts || []], [REQUESTS, b.requests || []]].map(([tab, list]) => ({ t: iyTab_(tab), tab: tab, list: list }));
  jobs.forEach((j) => {
    const cc = j.t.col('Client');
    const data = j.t.sh.getDataRange().getValues();
    j.list.forEach((x) => {
      if (!data[x.row - 1] || iyKey_(data[x.row - 1][cc]) !== iyKey_(x.client)) throw new Error('The sheet changed during the import (row ' + x.row + ' of ' + j.tab + '). Run the import again.');
    });
  });
  let stamped = 0;
  jobs.forEach((j) => {
    const idCol = iyCol_(j.t, 'AppId');
    j.list.forEach((x) => { j.t.sh.getRange(x.row, idCol + 1).setValue(x.id); stamped++; });
  });
  return { stamped: stamped };
}

// Email state of every row, so the webapp can catch up if a timer couldn't tell it.
function iyMailStatus_() {
  const out = { extracts: [], requests: [] };
  [[EXTRACTS, 'extracts'], [REQUESTS, 'requests']].forEach(([tab, key]) => {
    const t = iyTab_(tab);
    const idc = t.col('AppId');
    if (idc === -1) return;
    const data = t.sh.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const id = String(data[i][idc] || '').trim();
      if (!id) continue;
      if (tab === EXTRACTS) out.extracts.push({ id: id, status: String(data[i][t.col('PaymentStatus')] || '').trim(), thread: String(data[i][t.col('ClientEmailThread')] || '').trim() });
      else out.requests.push({ id: id, emailStatus: String(data[i][t.col('Email Status')] || '').trim() });
    }
  });
  return out;
}

// Writes a Finance Team request; sends it straight away when asked (a failed email stays TO SEND for the timer).
function iyPutRequest_(b) {
  const r = iyPut_(REQUESTS, b.row);
  if (!b.sendNow) return { sent: false };
  try {
    iySendRequestRow_(iyTab_(REQUESTS), r, iySetup_().config);
    return { sent: true };
  } catch (err) {
    return { sent: false, sendError: String(err.message || err) };
  }
}

// First email to the client with the invoice PDF attached; the row then moves to REMINDER.
// The webapp has checked the details; the row is written first so the sheet matches what is sent.
function iySendClient_(b) {
  const row = b.row;
  const r = iyPut_(EXTRACTS, row);
  const t = iyTab_(EXTRACTS);
  const fileId = iyFileId_(row.pdfUrl);
  if (!fileId) throw new Error('Add the invoice PDF link first');
  const setup = iySetup_();
  const client = setup.clients[iyKey_(row.client)];
  if (!client || !client.primaryEmail) throw new Error('"' + row.client + '" is not in the webapp client list (or has no email)');
  if (client.onHold) throw new Error(client.name + ' is on hold in the client list');
  if (!setup.config.firstTemplate) throw new Error('Add the first email template in Automator Settings');
  const html = iyFill_(setup.config.firstTemplate, {
    'Client Name': client.name, ContactPoint: client.contactPoint, 'Invoice number': row.invoiceNumber,
    'Due Date': iyFmt_(iyDate_(row.dueDate)), InvoiceType: row.invoiceType,
  });
  let blob;
  try { blob = DriveApp.getFileById(fileId).getBlob(); } catch (e) { throw new Error('Cannot open the invoice PDF in Google Drive. Check the link and that the sheet owner has access to it.'); }
  const options = { htmlBody: html, attachments: [blob] };
  if (client.ccEmails.length) options.cc = client.ccEmails.join(',');
  const sent = GmailApp.createDraft(client.primaryEmail, 'Invincible YOU - Invoice ' + row.invoiceNumber + ' - ' + client.name, '', options).send();
  const thread = sent.getThread().getId();
  t.sh.getRange(r, iyCol_(t, 'ClientEmailThread') + 1).setValue(thread);
  t.sh.getRange(r, iyCol_(t, 'PaymentStatus') + 1).setValue('REMINDER');
  return { thread: thread };
}

// The Finance Team's invoice PDF and the request's bills (base64), for the webapp to merge: bills from page 2 onwards.
// b.row: { id, pdfUrl, bills (one link per line), noBills, withBills }; force rebuilds from the original invoice.
function iyBillFiles_(b) {
  const row = b.row;
  const current = iyFileId_(row.pdfUrl);
  if (!current) throw new Error('Add the invoice PDF link first');
  const merged = Boolean(iyFileId_(row.withBills)) && iyFileId_(row.withBills) === current;
  if (merged && !b.force) return { already: true };
  const baseId = merged && iyFileId_(row.noBills) ? iyFileId_(row.noBills) : current;
  const links = String(row.bills || '').split(/\s+/).filter(Boolean);
  if (!links.length) return { bills: [] };
  const pack = (id) => {
    const f = DriveApp.getFileById(id);
    let blob = f.getBlob();
    if (!/pdf|jpeg|png/i.test(blob.getContentType())) blob = blob.getAs('application/pdf'); // Google Docs, other images
    return { name: f.getName(), type: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
  };
  let invoice;
  try {
    invoice = pack(baseId);
  } catch (e) {
    throw new Error('Cannot open the invoice PDF in Google Drive. Check the link and that the sheet owner has access to it.');
  }
  const bills = links.map((link) => {
    try {
      return pack(iyFileId_(link));
    } catch (e) {
      return { name: link, error: 'Cannot open this bill in Google Drive (check the link and that the sheet owner has access)' };
    }
  });
  return { invoice: invoice, baseId: baseId, currentId: current, bills: bills };
}

// Saves the merged PDF next to the original invoice (shared as view-only by link) and returns its link;
// the webapp records it and writes the row.
function iySaveMerged_(b) {
  const base = DriveApp.getFileById(b.baseId);
  const parents = base.getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = base.getName().replace(/\.pdf$/i, '') + ' - with bills.pdf';
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), 'application/pdf', name));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    throw new Error('The PDF with the bills was saved in Drive (' + file.getUrl() + ') but could not be shared as "Anyone with the link can view": ' + e.message);
  }
  if (b.previousMerged && b.previousMerged !== b.baseId) { try { DriveApp.getFileById(b.previousMerged).setTrashed(true); } catch (e) { /* already gone */ } }
  return { url: file.getUrl(), baseUrl: 'https://drive.google.com/file/d/' + b.baseId + '/view' };
}

/* ---------- timers ---------- */

function iyFill_(template, values) {
  return Object.keys(values).reduce((html, k) => html.split('{{' + k + '}}').join(iyEsc_(values[k]).replace(/\r?\n/g, '<br>')), template);
}

// The Drive file behind a link, as an email attachment.
function iyAttachment_(url) {
  const id = iyFileId_(url);
  if (!id) throw new Error('The attachment link is not a Google Drive file link');
  try {
    return DriveApp.getFileById(id).getBlob();
  } catch (e) {
    throw new Error('Cannot open the attachment in Google Drive. Check the link and that the sheet owner has access to the file.');
  }
}

// Hourly timer. Asks the webapp for work: in "app" mode it sends the emails the webapp says are due (Finance Team
// requests and client reminders); otherwise it sends the RequestInvoice rows as before.
function iyRequestEmails() {
  const res = iyPost_({ action: 'claim' });
  if (res.mode === 'app') {
    (res.jobs || []).forEach((job) => {
      const r = iySendJob_(job);
      Logger.log(job.label + ': ' + r.result + (r.error ? ' (' + r.error + ')' : ''));
      iyTell_(Object.assign({ jobId: job.jobId }, r));
    });
    return;
  }
  iyRequestEmailsSheet_();
}

// One email from the webapp's queue. Returns { result: sent | failed | skipped, thread, count, error }; never throws.
function iySendJob_(job) {
  try {
    if (job.kind === 'request') {
      const options = { htmlBody: job.html };
      if (job.cc && job.cc.length) options.cc = job.cc.join(',');
      if (job.attachments && job.attachments.length) options.attachments = job.attachments.map(iyAttachment_);
      let msg;
      try {
        msg = GmailApp.createDraft(job.to, job.subject, 'Please view this email in an HTML-compatible client.', options).send();
      } catch (err) {
        throw new Error(err.message + (options.attachments ? ' (Gmail allows 25 MB of attachments per email.)' : ''));
      }
      iyMarkRequestSent_(job.id); // keeps the old tab in step, so going back to the sheet timers can't send it again
      return { result: 'sent', thread: msg.getThread().getId() };
    }
    if (job.kind === 'reminder') {
      const thread = iyThread_(job.thread, job.to, job.invoiceNumber);
      if (!thread) return { result: 'failed', error: 'Gmail thread of the invoice email not found' };
      const sentSoFar = thread.getMessages().filter((m) => m.getBody().indexOf(REMINDER_TAG) !== -1).length;
      // the thread is the truth: send only if it holds fewer reminders than are due now
      const due = job.seq != null ? job.seq : job.due;
      if (sentSoFar >= due) return { result: 'skipped', count: sentSoFar, thread: thread.getId() };
      thread.replyAll('', { htmlBody: job.html + REMINDER_MARKER });
      return { result: 'sent', count: sentSoFar + 1, thread: thread.getId() };
    }
    return { result: 'failed', error: 'Unknown email kind' };
  } catch (err) {
    return { result: 'failed', error: String(err.message || err) };
  }
}

function iyMarkRequestSent_(id) {
  try {
    const t = iyTab_(REQUESTS);
    const r = iyFind_(t, id);
    if (r && t.col('Email Status') !== -1) t.sh.getRange(r, t.col('Email Status') + 1).setValue('SENT');
  } catch (e) { /* no tab any more: nothing to keep in step */ }
}

// Sheet mode: emails the Finance Team for each RequestInvoice row not yet SENT once its scheduled time has come.
function iyRequestEmailsSheet_() {
  const config = iySetup_().config;
  const req = iyTab_(REQUESTS);
  const statusCol = req.col('Email Status');
  if (statusCol === -1) return;
  const data = req.sh.getDataRange().getValues();
  const [hour, minute] = String(config.requestTime || '10:00').split(':').map(Number);
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][statusCol] || '').trim().toUpperCase() === 'SENT') continue;
    const date = iyDate_(data[i][req.col('InvoiceDate')]);
    if (!date) continue;
    const when = new Date(date.getTime());
    when.setDate(when.getDate() - (Number(config.requestDaysBefore) || 0));
    when.setHours(hour, minute, 0, 0);
    if (now < when) continue;
    try {
      iySendRequestRow_(req, i + 1, config);
    } catch (err) {
      Logger.log('RequestInvoice row ' + (i + 1) + ': not sent: ' + err.message); // the other rows still go out
    }
  }
}

function iySendRequestRow_(req, rowNo, config) {
  const emails = String(config.financeEmails || '').split(/[;,\s]+/).filter(Boolean);
  if (!emails.length) throw new Error('Add the Finance Team emails in Automator Settings');
  if (!config.requestTemplate) throw new Error('Add the Finance Team request template in Automator Settings');
  const v = req.sh.getRange(rowNo, 1, 1, req.headers.length).getValues()[0];
  const get = (name) => (req.col(name) === -1 ? '' : v[req.col(name)]);
  const html = iyFill_(config.requestTemplate, {
    InvoiceType: get('InvoiceType'), Client: get('Client'), PO_Number: get('PO_Number') || 'N/A', ItemDescription: get('Item&Description'),
    AmountwithoutGST: iyRupees_(String(get('AmountwithoutGST')).replace(/[^0-9.-]+/g, '')), InvoiceDate: iyFmt_(iyDate_(get('InvoiceDate'))),
  });
  const options = { htmlBody: html, cc: emails.slice(1).join(',') };
  const links = String(get('Attachment') || '').split(/\s+/).filter(Boolean);
  if (links.length) options.attachments = links.map(iyAttachment_);
  try {
    GmailApp.sendEmail(emails[0], 'Invoice Request: ' + get('Client') + ' ' + get('InvoiceType'), 'Please view this email in an HTML-compatible client.', options);
  } catch (err) {
    throw new Error(err.message + (links.length ? ' (Gmail allows 25 MB of attachments per email.)' : ''));
  }
  req.sh.getRange(rowNo, req.col('Email Status') + 1).setValue('SENT');
  const id = String(get('AppId') || '').trim();
  if (id) iyTell_({ kind: 'request', id: id });
}

// Daily: for REMINDER rows, replies in the client's thread when the next interval (days since invoice date) is reached.
function iyReminders() {
  const setup = iySetup_();
  if (setup.emailQueue === 'app') return; // the hourly timer sends reminders from the webapp's queue
  const intervals = setup.config.reminderIntervals || [];
  if (!setup.config.reminderTemplate) throw new Error('Add the reminder email template in Automator Settings');
  const t = iyTab_(EXTRACTS);
  const c = { status: t.col('PaymentStatus'), client: t.col('Client'), date: t.col('Invoice Date'), number: t.col('Invoice number'),
    thread: t.col('ClientEmailThread'), due: t.col('Due Date'), type: t.col('InvoiceType'), id: t.col('AppId') };
  const data = t.sh.getDataRange().getValues();
  const today = iyDate_(new Date());
  for (let i = 1; i < data.length; i++) {
    const v = data[i];
    if (String(v[c.status] || '').trim().toUpperCase() !== 'REMINDER') continue;
    const client = setup.clients[iyKey_(v[c.client])];
    const date = iyDate_(v[c.date]);
    if (!client || client.onHold || !date) { Logger.log('Row ' + (i + 1) + ': skipped (client missing, on hold, or no invoice date)'); continue; }
    try {
      const number = String(v[c.number] || '').trim();
      const thread = iyThread_(v[c.thread], client.primaryEmail, number);
      if (!thread) { Logger.log('Row ' + (i + 1) + ': Gmail thread not found'); continue; }
      const sentSoFar = thread.getMessages().filter((m) => m.getBody().indexOf(REMINDER_TAG) !== -1).length;
      const days = Math.round((today - date) / 864e5);
      if (sentSoFar >= intervals.length || days < intervals[sentSoFar]) continue;
      const html = iyFill_(setup.config.reminderTemplate, {
        'Client Name': client.name, ContactPoint: client.contactPoint, 'Invoice number': number,
        'Due Date': iyFmt_(iyDate_(v[c.due]) || v[c.due]), InvoiceType: v[c.type],
      }) + REMINDER_MARKER;
      thread.replyAll('', { htmlBody: html });
      t.sh.getRange(i + 1, c.thread + 1).setValue(thread.getId());
      Logger.log('Row ' + (i + 1) + ': reminder ' + (sentSoFar + 1) + ' sent to ' + client.name);
      const id = c.id === -1 ? '' : String(v[c.id] || '').trim();
      if (id) iyTell_({ kind: 'reminder', id: id, thread: thread.getId(), count: sentSoFar + 1 });
    } catch (err) {
      Logger.log('Row ' + (i + 1) + ': reminder failed: ' + err.message);
    }
  }
}

// Thread by saved id, by Gmail link, or by searching for the invoice number.
function iyThread_(saved, email, number) {
  const s = String(saved || '').trim();
  const tryId = (id) => { try { return GmailApp.getThreadById(id); } catch (e) { return null; } };
  if (s && s.indexOf('http') === -1 && s.indexOf('FMfc') !== 0) { const t = tryId(s); if (t) return t; }
  const last = s.split('/').pop();
  if (s.indexOf('http') !== -1 && /^[0-9a-fA-F]+$/.test(last)) { const t = tryId(last); if (t) return t; }
  if (email && number) { const found = GmailApp.search('"' + number + '" ' + email); if (found.length) return found[0]; }
  return null;
}

// Run once from the editor: replaces the old timers with the two new ones.
function iyInstallTriggers() {
  const old = ['processScheduledInvoiceEmails', 'processInvoiceEmails', 'iyRequestEmails', 'iyReminders'];
  ScriptApp.getProjectTriggers().forEach((t) => { if (old.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('iyRequestEmails').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('iyReminders').timeBased().everyDays(1).atHour(10).create();
  Logger.log('Timers installed: iyRequestEmails hourly, iyReminders daily at about 10 AM.');
}
