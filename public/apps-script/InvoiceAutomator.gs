// Invincible YOU · Client Invoice Automator. Replaces MenuAndUI.gs, Form.html, EmailTemplate.html,
// Email Scheduler and ClientEmail.gs. Settings and the client list now come from the webapp; this
// script keeps writing the RequestInvoice and Invoice Extracts tabs and sends from your Gmail.
// The webapp calls doPost(); iyRequestEmails and iyReminders run on timers (run iyInstallTriggers once).
const APP_URL = '__APP_URL__';
const APP_KEY = '__KEY__';
const DUE_DAYS = 45; // Due Date = Invoice Date + 45 days
const TDS_RATE = 0.1;
// Amt(ToBeReceived) = Amount with GST - 10% TDS on the amount without GST (matches the existing rows, e.g. 4,13,000 - 35,000).
// Reimbursement invoices carry no TDS, so for them it is the amount with GST.
const iyToBeReceived_ = (withGst, withoutGst, reimb) => Math.round((reimb ? withGst : withGst - TDS_RATE * withoutGst) * 100) / 100;
const REMINDER_TAG = 'GAS_INV_REMINDER';
const REMINDER_MARKER = '<span style="display:none;" class="gas-inv-reminder-tag">' + REMINDER_TAG + '</span>';

function doPost(e) {
  const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.key !== APP_KEY) return out({ error: 'Wrong key: copy the script again from Receivables, Automator Settings' });
    if (b.action === 'list') return out(iyList_());
    if (b.action === 'sheet') return out(iyReadOldSheetSetup_());
    if (b.action === 'bills') return out(iyBillFiles_(b));
    // Writes and emails one at a time, so a double click can't send twice.
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(30000)) return out({ error: 'The sheet is busy, please try again in a minute' });
    try {
      if (b.action === 'request') return out(iyRequest_(b));
      if (b.action === 'update') return out(iyUpdate_(b));
      if (b.action === 'send') return out(iySendClient_(b));
      if (b.action === 'saveMerged') return out(iySaveMerged_(b));
      if (b.action === 'delete') return out(iyDelete_(b));
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
const iyNum_ = (v) => Number(String(v).replace(/[^0-9.-]+/g, '')) || 0;
const iyFileId_ = (url) => (String(url || '').match(/[-\w]{25,}/) || [])[0] || null;
const iyEsc_ = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iyRupees_ = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  return { config: out.config, clients: clients };
}

function iyTab_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found in the sheet');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(iyNorm_);
  return { sh: sh, headers: headers, col: (name) => headers.indexOf(name) };
}

function iyExtracts_() {
  const t = iyTab_('Invoice Extracts');
  const c = {
    client: t.col('client'), number: t.col('invoicenumber'), date: t.col('invoicedate'), amount: t.col('amountwogst'), withGst: t.col('amtwithgst'), toReceive: t.col('amttobereceived'),
    due: t.col('duedate'), pdf: t.col('invoice'), status: t.col('paymentstatus'), thread: t.col('clientemailthread'),
    type: t.col('invoicetype'), received: t.col('pymntrcvddate'),
  };
  Object.keys(c).forEach((k) => { if (c[k] === -1) throw new Error('Invoice Extracts has no column for "' + k + '"'); });
  // Optional columns (-1 until first needed): a reimbursement request's bill links, and the invoice PDF before and after
  // the bills were added to it.
  c.bills = t.col('bills'); c.noBills = t.col('invoicewithoutbills'); c.withBills = t.col('invoicewithbills');
  return { sh: t.sh, width: t.headers.length, c: c };
}

// Adds an optional Invoice Extracts column at the end of the header row the first time it is needed.
function iyExtraCol_(x, header) {
  const headers = x.sh.getRange(1, 1, 1, x.sh.getLastColumn()).getValues()[0].map(iyNorm_);
  let i = headers.indexOf(iyNorm_(header));
  if (i === -1) { i = headers.length; x.sh.getRange(1, i + 1).setValue(header); }
  return i;
}

// RequestInvoice bill links by client|invoice date|amount, for invoices requested before the Bills column existed.
function iyRequestBills_() {
  const req = iyTab_('RequestInvoice');
  const a = req.col('attachment');
  const map = {};
  if (a === -1) return map;
  const data = req.sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (!/reimburs/i.test(String(data[i][req.col('invoicetype')] || ''))) continue;
    const links = String(data[i][a] || '').split(/\s+/).filter(Boolean);
    if (!links.length) continue;
    map[iyKey_(data[i][req.col('client')]) + '|' + iyIso_(iyDate_(data[i][req.col('invoicedate')])) + '|' + iyNum_(data[i][req.col('amountwithoutgst')]).toFixed(2)] = links;
  }
  return map;
}

// A reimbursement invoice's bill links: its Bills cell, else the matching RequestInvoice row's Attachment.
function iyBillLinks_(x, v, requestBills) {
  const c = x.c;
  if (!/reimburs/i.test(String(v[c.type] || ''))) return [];
  if (c.bills !== -1 && String(v[c.bills] || '').trim()) return String(v[c.bills]).split(/\s+/).filter(Boolean);
  return requestBills()[iyKey_(v[c.client]) + '|' + iyIso_(iyDate_(v[c.date])) + '|' + iyNum_(v[c.amount]).toFixed(2)] || [];
}

const iyMemo_ = (fn) => { let v; return () => (v === undefined ? (v = fn()) : v); };
// True when the invoice PDF link is the merged file this script made (the bills are already in it).
const iyHasBills_ = (x, v) => x.c.withBills !== -1 && Boolean(iyFileId_(v[x.c.withBills])) && iyFileId_(v[x.c.withBills]) === iyFileId_(v[x.c.pdf]);

// The row the webapp showed, checked against the client so a re-sorted sheet can't be written to the wrong row.
function iyRow_(x, row, client) {
  if (!(row >= 2 && row <= x.sh.getLastRow())) throw new Error('That row is no longer in the sheet. Refresh and try again.');
  const values = x.sh.getRange(row, 1, 1, x.width).getValues()[0];
  if (iyKey_(values[x.c.client]) !== iyKey_(client)) throw new Error('The sheet has changed since you loaded it. Refresh and try again.');
  return values;
}

function iyFill_(template, values) {
  return Object.keys(values).reduce((html, k) => html.split('{{' + k + '}}').join(iyEsc_(values[k]).replace(/\r?\n/g, '<br>')), template);
}

/* ---------- webapp actions ---------- */

function iyList_() {
  const x = iyExtracts_();
  const c = x.c;
  const data = x.sh.getDataRange().getValues();
  const rows = [];
  const requestBills = iyMemo_(iyRequestBills_);
  for (let i = 1; i < data.length; i++) {
    const v = data[i];
    if (!String(v[c.client] || '').trim()) continue;
    const date = iyDate_(v[c.date]);
    rows.push({
      row: i + 1, client: String(v[c.client]).trim(), invoiceNumber: String(v[c.number] || '').trim(),
      invoiceDate: iyFmt_(date || v[c.date]), invoiceDateIso: iyIso_(date), amount: Number(String(v[c.amount]).replace(/[^0-9.-]+/g, '')) || 0,
      withGst: Number(String(v[c.withGst]).replace(/[^0-9.-]+/g, '')) || 0, toReceive: Number(String(v[c.toReceive]).replace(/[^0-9.-]+/g, '')) || 0,
      dueDate: iyFmt_(iyDate_(v[c.due]) || v[c.due]), pdfUrl: String(v[c.pdf] || '').trim(), status: String(v[c.status] || '').trim(),
      emailed: Boolean(String(v[c.thread] || '').trim()), invoiceType: String(v[c.type] || '').trim(),
      receivedDate: iyFmt_(iyDate_(v[c.received]) || v[c.received]), receivedDateIso: iyIso_(iyDate_(v[c.received])),
      billCount: iyBillLinks_(x, v, requestBills).length, billsAttached: iyHasBills_(x, v),
    });
  }
  return { rows: rows };
}

// Same rows the old "Request Invoice" dialog wrote: one in RequestInvoice, one NEW_ENTRY in Invoice Extracts.
function iyRequest_(b) {
  const date = iyDate_(b.invoiceDate);
  if (!date) throw new Error('Invalid invoice date');
  const attachments = (b.attachments || []).filter(Boolean);
  attachments.forEach(iyAttachment_); // checked before any row is written, so a bad link adds nothing
  let req = iyTab_('RequestInvoice');
  if (req.col('attachment') === -1) { // added once, at the end of the row
    req.sh.getRange(1, req.headers.length + 1).setValue('Attachment');
    req = iyTab_('RequestInvoice');
  }
  const statusCol = req.col('emailstatus');
  if (statusCol === -1) throw new Error('RequestInvoice has no "Email Status" column');
  const row = new Array(req.headers.length).fill('');
  const put = (i, v) => { if (i !== -1) row[i] = v; };
  put(req.col('invoicetype'), b.invoiceType);
  put(req.col('client'), b.client);
  put(req.col('invoicedate'), date);
  put(req.col('itemdescription'), b.description);
  put(req.col('ponumber'), b.poNumber || 'N/A');
  put(req.col('amountwithoutgst'), Number(b.amount));
  put(statusCol, 'TO SEND');
  put(req.col('attachment'), attachments.join('\n')); // one Drive link per line
  req.sh.appendRow(row);
  const reqRow = req.sh.getLastRow();
  if (req.col('amountwithoutgst') !== -1) req.sh.getRange(reqRow, req.col('amountwithoutgst') + 1).setNumberFormat('₹#,##0.00');
  req.sh.getRange(reqRow, req.col('invoicedate') + 1).setNumberFormat('dd/mm/yyyy');

  const x = iyExtracts_();
  const due = new Date(date.getTime());
  due.setDate(due.getDate() + DUE_DAYS);
  const ext = new Array(x.width).fill('');
  ext[x.c.client] = b.client;
  ext[x.c.number] = ' ';
  ext[x.c.date] = date;
  ext[x.c.amount] = Number(b.amount);
  ext[x.c.due] = due;
  ext[x.c.type] = b.invoiceType === 'Service' ? 'for the service rendered.' : 'for reimbursement of the expenses incurred.';
  ext[x.c.status] = 'NEW_ENTRY';
  x.sh.appendRow(ext);
  const extRow = x.sh.getLastRow();
  x.sh.getRange(extRow, x.c.amount + 1).setNumberFormat('₹#,##0.00');
  x.sh.getRange(extRow, x.c.date + 1).setNumberFormat('dd/mm/yyyy');
  x.sh.getRange(extRow, x.c.due + 1).setNumberFormat('dd/mm/yyyy');
  // Reimbursement bills are kept on the invoice row too, to be added to the client's PDF when it is approved.
  if (/reimburs/i.test(b.invoiceType) && attachments.length) x.sh.getRange(extRow, iyExtraCol_(x, 'Bills') + 1).setValue(attachments.join('\n'));

  if (!b.sendNow) return { sent: false };
  // The rows are saved either way; a failed email stays TO SEND and the hourly timer retries it.
  try {
    iySendRequestRow_(req, reqRow, iySetup_().config);
    return { sent: true };
  } catch (err) {
    return { sent: false, sendError: String(err.message || err) };
  }
}

function iyUpdate_(b) {
  const x = iyExtracts_();
  const v = iyRow_(x, b.row, b.client);
  const cell = (col) => x.sh.getRange(b.row, col + 1);
  cell(x.c.number).setValue(b.invoiceNumber || ' ');
  cell(x.c.pdf).setValue(b.pdfUrl || '');
  if (b.withGst) { // left as is when not given
    cell(x.c.withGst).setValue(Number(b.withGst)).setNumberFormat('₹#,##0.00');
    const withoutGst = Number(String(v[x.c.amount]).replace(/[^0-9.-]+/g, '')) || 0;
    const reimb = /reimburs/i.test(String(v[x.c.type] || ''));
    cell(x.c.toReceive).setValue(iyToBeReceived_(Number(b.withGst), withoutGst, reimb)).setNumberFormat('₹#,##0.00');
  }
  cell(x.c.status).setValue(b.status);
  if (b.status === 'Payment Received') cell(x.c.received).setValue(iyDate_(b.receivedDate)).setNumberFormat('dd/mm/yyyy');
  return { ok: true };
}

// First email to the client with the invoice PDF attached; the row then moves to REMINDER.
function iySendClient_(b) {
  const x = iyExtracts_();
  const v = iyRow_(x, b.row, b.client);
  const c = x.c;
  const status = String(v[c.status] || '').trim().toUpperCase();
  if (status !== 'NEW_ENTRY' && status !== 'APPROVED') throw new Error('This invoice has already been emailed (status ' + v[c.status] + ')');
  const number = String(v[c.number] || '').trim();
  if (!number) throw new Error('Add the invoice number first');
  const fileId = iyFileId_(v[c.pdf]);
  if (!fileId) throw new Error('Add the invoice PDF link first');
  if (!(Number(String(v[c.withGst]).replace(/[^0-9.-]+/g, '')) > 0)) throw new Error('Add the amount with GST first');
  if (iyBillLinks_(x, v, iyMemo_(iyRequestBills_)).length && !iyHasBills_(x, v)) throw new Error('Approve this reimbursement invoice first so its bills are added to the PDF');
  const setup = iySetup_();
  const client = setup.clients[iyKey_(v[c.client])];
  if (!client || !client.primaryEmail) throw new Error('"' + v[c.client] + '" is not in the webapp client list (or has no email)');
  if (client.onHold) throw new Error(client.name + ' is on hold in the client list');
  if (!setup.config.firstTemplate) throw new Error('Add the first email template in Automator Settings');

  const html = iyFill_(setup.config.firstTemplate, {
    'Client Name': client.name, ContactPoint: client.contactPoint, 'Invoice number': number,
    'Due Date': iyFmt_(iyDate_(v[c.due]) || v[c.due]), InvoiceType: v[c.type],
  });
  const options = { htmlBody: html, attachments: [DriveApp.getFileById(fileId).getBlob()] };
  if (client.ccEmails.length) options.cc = client.ccEmails.join(',');
  const sent = GmailApp.createDraft(client.primaryEmail, 'Invincible YOU - Invoice ' + number + ' - ' + client.name, '', options).send();
  x.sh.getRange(b.row, c.thread + 1).setValue(sent.getThread().getId());
  x.sh.getRange(b.row, c.status + 1).setValue('REMINDER');
  return { ok: true };
}

// The Finance Team's invoice PDF and the request's bills (base64), for the webapp to merge: bills from page 2 onwards.
// Re-approving keeps the bills once: a PDF that already has them is skipped unless force, which rebuilds from the original.
function iyBillFiles_(b) {
  const x = iyExtracts_();
  const v = iyRow_(x, b.row, b.client);
  const current = iyFileId_(v[x.c.pdf]);
  if (!current) throw new Error('Add the invoice PDF link first');
  const merged = iyHasBills_(x, v);
  if (merged && !b.force) return { already: true };
  const baseId = merged && x.c.noBills !== -1 && iyFileId_(v[x.c.noBills]) ? iyFileId_(v[x.c.noBills]) : current;
  const links = iyBillLinks_(x, v, iyMemo_(iyRequestBills_));
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

// Saves the merged PDF next to the original invoice and points the row's Invoice link at it.
function iySaveMerged_(b) {
  const x = iyExtracts_();
  const v = iyRow_(x, b.row, b.client);
  if (iyFileId_(v[x.c.pdf]) !== b.currentId) throw new Error('The invoice PDF link changed meanwhile. Refresh and approve again.');
  const base = DriveApp.getFileById(b.baseId);
  const parents = base.getParents();
  const folder = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const name = base.getName().replace(/\.pdf$/i, '') + ' - with bills.pdf';
  const file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), 'application/pdf', name));
  // Anyone with the link can view, so the client and the webapp's PDF preview can open it.
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    throw new Error('The PDF with the bills was saved in Drive (' + file.getUrl() + ') but could not be shared as "Anyone with the link can view": ' + e.message);
  }
  if (iyHasBills_(x, v)) { try { DriveApp.getFileById(iyFileId_(v[x.c.withBills])).setTrashed(true); } catch (e) { /* already gone */ } }
  x.sh.getRange(b.row, iyExtraCol_(x, 'Invoice Without Bills') + 1).setValue('https://drive.google.com/file/d/' + b.baseId + '/view');
  x.sh.getRange(b.row, iyExtraCol_(x, 'Invoice With Bills') + 1).setValue(file.getUrl());
  x.sh.getRange(b.row, x.c.pdf + 1).setValue(file.getUrl());
  return { url: file.getUrl() };
}

// Deletes a NEW_ENTRY invoice row (requested by mistake). Its RequestInvoice row goes too while the Finance Team
// email is still unsent, so the timer won't email it; a request already sent stays as the record of what was asked.
function iyDelete_(b) {
  const x = iyExtracts_();
  const v = iyRow_(x, b.row, b.client);
  const status = String(v[x.c.status] || '').trim();
  if (status.toUpperCase() !== 'NEW_ENTRY') throw new Error('Only new entries can be deleted (this one is ' + status + ')');
  const key = iyKey_(v[x.c.client]) + '|' + iyIso_(iyDate_(v[x.c.date])) + '|' + iyNum_(v[x.c.amount]).toFixed(2);
  const req = iyTab_('RequestInvoice');
  const sc = req.col('emailstatus');
  const data = req.sh.getDataRange().getValues();
  let request = 'none';
  for (let i = data.length - 1; i >= 1; i--) { // newest matching request
    const k = iyKey_(data[i][req.col('client')]) + '|' + iyIso_(iyDate_(data[i][req.col('invoicedate')])) + '|' + iyNum_(data[i][req.col('amountwithoutgst')]).toFixed(2);
    if (k !== key) continue;
    if (String(data[i][sc] || '').trim().toUpperCase() === 'SENT') { request = 'sent'; break; }
    req.sh.deleteRow(i + 1);
    request = 'removed';
    break;
  }
  x.sh.deleteRow(b.row);
  return { request: request };
}

/* ---------- timers ---------- */

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

// Hourly: emails the Finance Team for each RequestInvoice row not yet SENT once its scheduled time has come.
function iyRequestEmails() {
  const config = iySetup_().config;
  const req = iyTab_('RequestInvoice');
  const statusCol = req.col('emailstatus');
  const data = req.sh.getDataRange().getValues();
  const [hour, minute] = String(config.requestTime || '10:00').split(':').map(Number);
  const now = new Date();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][statusCol] || '').trim().toUpperCase() === 'SENT') continue;
    const date = iyDate_(data[i][req.col('invoicedate')]);
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
    InvoiceType: get('invoicetype'), Client: get('client'), PO_Number: get('ponumber') || 'N/A', ItemDescription: get('itemdescription'),
    AmountwithoutGST: iyRupees_(String(get('amountwithoutgst')).replace(/[^0-9.-]+/g, '')), InvoiceDate: iyFmt_(iyDate_(get('invoicedate'))),
  });
  const options = { htmlBody: html, cc: emails.slice(1).join(',') };
  const links = String(get('attachment') || '').split(/\s+/).filter(Boolean);
  if (links.length) options.attachments = links.map(iyAttachment_);
  try {
    GmailApp.sendEmail(emails[0], 'Invoice Request: ' + get('client') + ' ' + get('invoicetype'), 'Please view this email in an HTML-compatible client.', options);
  } catch (err) {
    throw new Error(err.message + (links.length ? ' (Gmail allows 25 MB of attachments per email.)' : ''));
  }
  req.sh.getRange(rowNo, req.col('emailstatus') + 1).setValue('SENT');
}

// Daily: for REMINDER rows, replies in the client's thread when the next interval (days since invoice date) is reached.
function iyReminders() {
  const setup = iySetup_();
  const intervals = setup.config.reminderIntervals || [];
  if (!setup.config.reminderTemplate) throw new Error('Add the reminder email template in Automator Settings');
  const x = iyExtracts_();
  const c = x.c;
  const data = x.sh.getDataRange().getValues();
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
      x.sh.getRange(i + 1, c.thread + 1).setValue(thread.getId());
      Logger.log('Row ' + (i + 1) + ': reminder ' + (sentSoFar + 1) + ' sent to ' + client.name);
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

/* ---------- one-time import of the old Config and ClientList tabs ---------- */

function iyReadOldSheetSetup_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const clients = [];
  const list = ss.getSheetByName('ClientList');
  if (list) {
    list.getDataRange().getValues().slice(1).forEach((r) => {
      if (String(r[0] || '').trim()) clients.push({ name: String(r[0]).trim(), emails: String(r[1] || ''), contact: String(r[2] || '').trim(), note: String(r[3] || '') });
    });
  }
  const cfg = {};
  const sheet = ss.getSheetByName('Config');
  if (sheet) sheet.getDataRange().getValues().forEach((r) => { if (String(r[0] || '').trim()) cfg[iyNorm_(r[0])] = r[1]; });
  const find = (part) => { const k = Object.keys(cfg).find((key) => key.indexOf(part) !== -1); return k === undefined ? undefined : cfg[k]; };
  const config = {};
  const set = (field, value) => { if (value !== undefined && value !== '') config[field] = value; };
  set('financeEmails', find('financeteamemail') && String(find('financeteamemail')));
  set('requestDaysBefore', find('triggerinvoicerequestdate') !== undefined ? Number(find('triggerinvoicerequestdate')) || 0 : undefined);
  const time = find('triggerinvoicerequesttime');
  if (time instanceof Date) set('requestTime', Utilities.formatDate(time, ss.getSpreadsheetTimeZone(), 'HH:mm'));
  else if (time) {
    const m = String(time).match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (m) {
      let h = +m[1];
      if (m[3] && m[3].toUpperCase() === 'PM' && h < 12) h += 12;
      if (m[3] && m[3].toUpperCase() === 'AM' && h === 12) h = 0;
      set('requestTime', ('0' + h).slice(-2) + ':' + ('0' + m[2]).slice(-2));
    }
  }
  set('invoiceTypes', find('invoicetype') && String(find('invoicetype')));
  set('reminderIntervals', find('reminderintervals') && String(find('reminderintervals')));
  set('firstTemplate', find('firstemailtemplate') && String(find('firstemailtemplate')));
  set('reminderTemplate', find('reminderemailtemplate') && String(find('reminderemailtemplate')));
  try { set('requestTemplate', HtmlService.createHtmlOutputFromFile('EmailTemplate').getContent()); } catch (e) {}
  return { clients: clients, config: config };
}
