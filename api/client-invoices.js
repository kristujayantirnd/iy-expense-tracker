// Client Invoice Automator. Clients and settings live here. Emails go out from Gmail through the sheet's Apps Script.
// Two modes (settings.receivablesSource):
//   sheet (until the import): the invoice rows live in the sheet (RequestInvoice, Invoice Extracts; InvoiceAutomatorSheet.gs)
//   db (after "Move to database"): the rows live in receivable_invoices / invoice_requests; the sheet keeps those two
//      tabs as the mailing queue (InvoiceAutomator.gs), each row carrying the record id in AppId. Every change is
//      saved here first, then written to the sheet; a failed sheet write is kept on the record for "Retry sheet sync".
// Only Admin and Finance Admin use it.
// GET ?key=…            -> the Apps Script: { config, clients }
// GET                   -> { config, clients, script, key (admin) }
// GET ?rows=1           -> { rows } from Invoice Extracts
// POST {action, …}      -> config | client | import | draft | deleteDraft | request | rowDraft | deleteRowDraft | update | delete | send | script (admin)
//                          db mode also: importSheet (admin, the one-time move) | resync | syncMail
// POST {key, action: 'mailed', kind, id, thread?} -> the Apps Script timers reporting an email they sent (db mode)
// Update-invoice drafts (rowDraft) stay in the app (settings 'invoiceRowDrafts') until saved to the sheet.
import { sql, requireUser, isFinanceAdmin, invoiceToken } from './_lib.js';
import { SCRIPT_URL } from './_pdf.js';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Approving a reimbursement invoice merges its bills into the PDF through the sheet script (a few round trips).
export const config = { maxDuration: 60 };

class Bad extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^@\s;,]+@[^@\s;,]+\.[^@\s;,]+$/;
// Invoice Extracts PaymentStatus values the Apps Script acts on.
export const STATUSES = ['NEW_ENTRY', 'APPROVED', 'REMINDER', 'Payment Received'];
const DEFAULT_CONFIG = {
  financeEmails: '', requestDaysBefore: 0, requestTime: '10:00', invoiceTypes: ['Service', 'Reimbursed Expense'],
  reminderIntervals: [15, 30, 40, 43], requestTemplate: '', firstTemplate: '', reminderTemplate: '',
};

const text = (v, max = 200, required = false) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new Bad('Required field is empty');
  if (s.length > max) throw new Bad('Text is too long');
  return s;
};
const date = (v) => {
  const s = String(v || '');
  if (!DATE.test(s) || Number.isNaN(Date.parse(s))) throw new Bad('Pick a valid date');
  return s;
};
// "a@x; b@y, c@z" -> "a@x; b@y; c@z" (the first address is the main recipient)
export function emailList(v, required = true) {
  const list = String(v || '').split(/[;,\s]+/).filter(Boolean);
  const bad = list.find((e) => !EMAIL.test(e));
  if (bad) throw new Bad(`Not a valid email: ${bad}`);
  if (required && !list.length) throw new Bad('Add at least one email');
  return [...new Set(list)].join('; ');
}
export function cleanConfig(c = {}) {
  const days = Number(c.requestDaysBefore);
  if (!Number.isInteger(days) || days < 0 || days > 60) throw new Bad('Days before invoice date must be 0 to 60');
  const time = String(c.requestTime || '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Bad('Pick a valid request time');
  const types = [...new Set((Array.isArray(c.invoiceTypes) ? c.invoiceTypes : String(c.invoiceTypes || '').split(','))
    .map((t) => text(t, 50)).filter(Boolean))];
  if (!types.length) throw new Bad('Add at least one invoice type');
  const intervals = (Array.isArray(c.reminderIntervals) ? c.reminderIntervals : String(c.reminderIntervals || '').split(','))
    .map((n) => String(n).trim()).filter(Boolean).map(Number);
  if (intervals.some((n, i) => !Number.isInteger(n) || n < 1 || n > 365 || (i && n <= intervals[i - 1]))) {
    throw new Bad('Reminder intervals must be whole days (1 to 365) in increasing order, e.g. 15, 30, 40');
  }
  return {
    financeEmails: emailList(c.financeEmails, false), requestDaysBefore: days, requestTime: time, invoiceTypes: types, reminderIntervals: intervals,
    requestTemplate: text(c.requestTemplate, 100000), firstTemplate: text(c.firstTemplate, 100000), reminderTemplate: text(c.reminderTemplate, 100000),
  };
}

const getSetting = async (db, key) => (await db`select value from settings where key = ${key}`)[0]?.value || '';
const setSetting = (db, key, value) => db`insert into settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
async function readConfig(db) {
  const raw = await getSetting(db, 'invoiceConfig');
  return { ...DEFAULT_CONFIG, ...(raw ? JSON.parse(raw) : {}) };
}
const readClients = (db) => db`select id, name, emails, contact, on_hold as "onHold" from clients order by name`;
// Drafts of the Update invoice dialog, keyed by sheet row + client + invoice date so a re-sorted sheet can't
// attach a draft to another invoice. Written with jsonb merge/delete so two people never overwrite each other's drafts.
const ROW_DRAFTS = 'invoiceRowDrafts';
const rowDraftKey = (u) => `${rowNo(u.row)}|${text(u.client, 200, true).toLowerCase()}|${text(u.invoiceDateIso, 10)}`;
async function readRowDrafts(db) {
  const raw = await getSetting(db, ROW_DRAFTS);
  return raw ? JSON.parse(raw) : {};
}
const dropRowDraft = (db, key) => db`update settings set value = (value::jsonb - ${key}::text)::text where key = ${ROW_DRAFTS}`;
const readDrafts = (db) => db`select id, client, invoice_type as "invoiceType", po_number as "poNumber", items,
                                     to_char(updated_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "updatedOn" from reimb_requests order by updated_at desc`;

// Runs one action in the sheet's Apps Script (it reads the config and clients back from /api/client-invoices?key=).
async function script(db, payload) {
  const url = await getSetting(db, 'invoiceScript');
  if (!SCRIPT_URL.test(url)) throw new Bad('The admin has not connected the Google Sheet yet (Receivables, Automator Settings).');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // Apps Script reads the raw body
      body: JSON.stringify({ key: invoiceToken(), ...payload }),
      redirect: 'follow',
    });
  } catch {
    throw new Bad('Could not reach the Google Sheet script. Please try again.');
  }
  const reply = await res.json().catch(() => ({ error: `The sheet script answered with HTTP ${res.status}. Check it is deployed with access "Anyone".` }));
  if (reply.error) throw new Bad(reply.error);
  return reply;
}

async function act(db, me, body) {
  if (body?.action === 'importSheet') return importSheet(db, me);
  if (DB_ACTIONS[body?.action] && (await isDb(db))) return DB_ACTIONS[body.action](db, me, body);
  switch (body?.action) {
    case 'config':
      await setSetting(db, 'invoiceConfig', JSON.stringify(cleanConfig(body.config)));
      return {};
    case 'client': {
      const c = body.client || {};
      const emails = emailList(c.emails);
      const contact = text(c.contact, 100);
      const onHold = c.onHold === true;
      if (c.id) {
        if (!Number.isInteger(c.id)) throw new Bad('Client not found');
        const rows = await db`update clients set emails = ${emails}, contact = ${contact}, on_hold = ${onHold} where id = ${c.id} returning id`;
        if (!rows.length) throw new Bad('Client not found');
      } else {
        const rows = await db`insert into clients (name, emails, contact, on_hold) values (${text(c.name, 200, true)}, ${emails}, ${contact}, ${onHold})
                              on conflict do nothing returning id`;
        if (!rows.length) throw new Bad('A client with that name already exists');
      }
      return {};
    }
    case 'import': {
      // One-time copy of the sheet's Config and ClientList tabs. Existing clients are kept; settings are replaced.
      const sheet = await script(db, { action: 'sheet' });
      const skipped = [];
      let added = 0;
      for (const c of sheet.clients || []) {
        try {
          const rows = await db`insert into clients (name, emails, contact, on_hold) values (${text(c.name, 200, true)}, ${emailList(c.emails)}, ${text(c.contact, 100)}, ${/hold/i.test(c.note || '')})
                                on conflict do nothing returning id`;
          if (rows.length) added++;
        } catch (e) {
          if (!(e instanceof Bad)) throw e;
          skipped.push(`${c.name || '(no name)'}: ${e.message}`);
        }
      }
      if (sheet.config) await setSetting(db, 'invoiceConfig', JSON.stringify(cleanConfig({ ...(await readConfig(db)), ...sheet.config })));
      return { notice: `Imported ${added} new client(s) and the settings.${skipped.length ? ' Skipped: ' + skipped.join('; ') : ''}` };
    }
    case 'draft':
      await saveDraft(db, me, body.request || {});
      return { notice: 'Saved as pending. Add more rows any time, then submit the request.' };
    case 'deleteDraft':
      await db`delete from reimb_requests where id = ${idOf(body.id)}`;
      return { notice: 'Pending request deleted' };
    case 'request': {
      const r = body.request || {};
      const { invoiceType, client } = await requestBasics(db, r);
      let description, amount, attachments, draftId = null;
      if (Array.isArray(r.items)) {
        // Reimbursement built row by row: saved first, so the rows are kept if the sheet can't be reached.
        draftId = await saveDraft(db, me, r);
        const items = cleanItems(r.items);
        description = items.map((it) => `${it.particulars} - ${rupees(it.amount)}`).join('\n');
        amount = Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
        attachments = items.map((it) => it.link).filter(Boolean);
      } else {
        description = text(r.description, 1000, true);
        amount = Math.round(Number(r.amount) * 100) / 100;
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) throw new Bad('Amount must be a number above 0');
        attachments = [driveLink(r.attachmentUrl, 'The attachment must be a Google Drive file link')].filter(Boolean);
      }
      const out = await script(db, {
        action: 'request', invoiceType, client, invoiceDate: date(r.invoiceDate), poNumber: text(r.poNumber, 300) || 'N/A',
        description, amount, attachments, sendNow: r.sendNow === true,
      });
      if (draftId) await db`delete from reimb_requests where id = ${draftId}`; // now in the sheet
      if (out.sendError) return { notice: `Invoice requested, but the Finance Team email failed: ${out.sendError} It is retried every hour; don't request it again.` };
      return { notice: out.sent ? 'Invoice requested and emailed to the Finance Team' : 'Invoice requested. The Finance Team email goes out at the scheduled time.' };
    }
    case 'rowDraft': {
      // Partial details are fine here; the completeness checks run when it is saved to the sheet.
      const u = body.update || {};
      const withGst = u.withGst === '' || u.withGst == null ? null : Math.round(Number(u.withGst) * 100) / 100;
      if (withGst !== null && (!Number.isFinite(withGst) || withGst <= 0 || withGst > 1e10)) throw new Bad('Amount with GST must be a number above 0');
      const status = STATUSES.includes(String(u.status)) ? String(u.status) : 'NEW_ENTRY';
      const draft = {
        invoiceNumber: text(u.invoiceNumber, 50), pdfUrl: text(u.pdfUrl, 500), withGst, status,
        receivedDate: DATE.test(String(u.receivedDate || '')) ? u.receivedDate : '',
        by: me.name || me.email, on: new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }),
      };
      const entry = JSON.stringify({ [rowDraftKey(u)]: draft });
      await db`insert into settings (key, value) values (${ROW_DRAFTS}, ${entry}) on conflict (key) do update set value = (settings.value::jsonb || excluded.value::jsonb)::text`;
      return { notice: 'Saved as draft. The sheet is unchanged until you save it to the sheet.' };
    }
    case 'deleteRowDraft':
      await dropRowDraft(db, rowDraftKey(body.update || {}));
      return { notice: 'Draft discarded' };
    case 'update': {
      const u = body.update || {};
      const status = String(u.status || '');
      if (!STATUSES.includes(status)) throw new Bad('Unknown status');
      const pdfUrl = driveLink(u.pdfUrl, 'Paste the Google Drive link of the invoice PDF');
      const invoiceNumber = text(u.invoiceNumber, 50);
      const withGst = u.withGst === '' || u.withGst == null ? null : Math.round(Number(u.withGst) * 100) / 100;
      if (withGst !== null && (!Number.isFinite(withGst) || withGst <= 0 || withGst > 1e10)) throw new Bad('Amount with GST must be a number above 0');
      const missing = readyMissing({ invoiceNumber, pdfUrl, withGst });
      if (['APPROVED', 'REMINDER'].includes(status) && missing.length) throw new Bad(`Add the ${missing.join(', ')} before choosing this status`);
      await script(db, {
        action: 'update', row: rowNo(u.row), client: text(u.client, 200, true), invoiceNumber, pdfUrl, withGst, status,
        receivedDate: status === 'Payment Received' ? date(u.receivedDate) : '',
      });
      await dropRowDraft(db, rowDraftKey(u)); // now in the sheet
      const bills = u.attachBills === true && status === 'APPROVED' ? await attachBills(db, rowNo(u.row), text(u.client, 200, true), u.rebuildBills === true) : '';
      return { notice: 'Invoice updated in the sheet' + bills };
    }
    case 'delete': {
      // New entries only (checked again by the sheet script). Rows below move up one, so their drafts follow them.
      const row = rowNo(body.update?.row);
      const out = await script(db, { action: 'delete', row, client: text(body.update?.client, 200, true) });
      await dropRowDraft(db, rowDraftKey(body.update));
      const drafts = await readRowDrafts(db);
      const moved = Object.fromEntries(Object.entries(drafts).map(([k, d]) => {
        const [r, ...rest] = k.split('|');
        return [Number(r) > row ? [Number(r) - 1, ...rest].join('|') : k, d];
      }));
      if (Object.keys(drafts).some((k) => Number(k.split('|')[0]) > row)) await setSetting(db, ROW_DRAFTS, JSON.stringify(moved));
      return { notice: 'Invoice deleted from the sheet.' + (out.request === 'removed' ? ' Its request to the Finance Team had not been emailed yet and is removed too.'
        : out.request === 'sent' ? ' The Finance Team was already emailed about it, so let them know it is cancelled.' : '') };
    }
    case 'send':
      await script(db, { action: 'send', row: rowNo(body.row), client: text(body.client, 200, true) });
      return { notice: 'Invoice emailed to the client. Reminders now follow the configured intervals.' };
    case 'script': {
      if (me.role !== 'admin') throw new Bad('Only the admin can connect the Google Sheet');
      const url = String(body.script || '').trim();
      if (url && !SCRIPT_URL.test(url)) throw new Bad('The script link must look like https://script.google.com/macros/s/…/exec');
      await setSetting(db, 'invoiceScript', url);
      return {};
    }
  }
  throw new Bad('Unknown action');
}


/* ================= Receivables in the database (db mode) ================= */

export const isDb = async (db) => (await getSetting(db, 'receivablesSource')) === 'db';
export const DUE_DAYS = 45; // Due Date = Invoice Date + 45 days
const r2 = (n) => Math.round(n * 100) / 100;
export const isReimbType = (t) => /reimburs/i.test(t || '');
// Amount to be received: amount with GST - 10% TDS on the amount without GST; reimbursements carry no TDS.
export const toBeReceived = (withGst, amount, reimb) => r2(reimb ? withGst : withGst - 0.1 * amount);
const fileId = (url) => (String(url || '').match(/[-\w]{25,}/) || [])[0] || null;
const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
export const typeSentence = (invoiceType) => (invoiceType === 'Service' ? 'for the service rendered.' : 'for reimbursement of the expenses incurred.');

export async function invoiceRecords(db, id = null) {
  return db`select id, client, invoice_number as "invoiceNumber", to_char(invoice_date, 'YYYY-MM-DD') as "invoiceDateIso", category,
                   amount::float8 as amount, with_gst::float8 as "withGst", to_receive::float8 as "toReceive", to_char(due_date, 'YYYY-MM-DD') as "dueDateIso",
                   pdf_url as "pdfUrl", status, email_thread as thread, invoice_type as "invoiceType", to_char(received_date, 'YYYY-MM-DD') as "receivedDateIso",
                   bills, pdf_without_bills as "noBills", pdf_with_bills as "withBills", draft, request_id as "requestId", sheet_error as "sheetError"
            from receivable_invoices where (${id}::int is null or id = ${id}) order by invoice_date nulls last, id`;
}

// A record in the shape the Manage Invoices screen uses (same fields the sheet rows had, with id for row).
const billLinks = (r) => (isReimbType(r.invoiceType) ? String(r.bills || '').split(/\s+/).filter(Boolean) : []);
const screenRow = (r) => ({
  id: r.id, client: r.client, invoiceNumber: r.invoiceNumber, invoiceDate: dmy(r.invoiceDateIso), invoiceDateIso: r.invoiceDateIso || '', category: r.category,
  amount: r.amount || 0, withGst: r.withGst || 0, toReceive: r.toReceive || 0, dueDate: dmy(r.dueDateIso), dueDateIso: r.dueDateIso || '', pdfUrl: r.pdfUrl, status: r.status,
  emailed: Boolean(r.thread), invoiceType: r.invoiceType, receivedDate: dmy(r.receivedDateIso), receivedDateIso: r.receivedDateIso || '',
  billCount: billLinks(r).length, billsAttached: Boolean(fileId(r.withBills)) && fileId(r.withBills) === fileId(r.pdfUrl), draft: r.draft || null, sheetError: r.sheetError,
});

// What the sheet row holds (the Apps Script writes these by AppId).
const extractRow = (r) => ({ id: r.id, client: r.client, invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDateIso || '', category: r.category, amount: r.amount,
  withGst: r.withGst, toReceive: r.toReceive, dueDate: r.dueDateIso || '', pdfUrl: r.pdfUrl, status: r.status, thread: r.thread, invoiceType: r.invoiceType,
  receivedDate: r.receivedDateIso || '', bills: r.bills, noBills: r.noBills, withBills: r.withBills });
async function requestRow(db, id) {
  const [q] = await db`select id, invoice_type as "invoiceType", client, category, to_char(invoice_date, 'YYYY-MM-DD') as "invoiceDate", description,
                              po_number as "poNumber", amount::float8 as amount, email_status as "emailStatus", attachments from invoice_requests where id = ${id}`;
  return q;
}

// Writes a record's sheet row; a failure is kept on the record (for Retry sheet sync) and returned, never thrown.
export async function pushExtract(db, id) {
  const [r] = await invoiceRecords(db, id);
  if (!r) return '';
  try {
    await script(db, { action: 'putExtract', row: extractRow(r) });
    await db`update receivable_invoices set sheet_error = '' where id = ${id}`;
    return '';
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await db`update receivable_invoices set sheet_error = ${msg} where id = ${id}`;
    return msg;
  }
}
export async function pushRequest(db, id, sendNow = false) {
  const row = await requestRow(db, id);
  if (!row) return { error: '' };
  try {
    const out = await script(db, { action: 'putRequest', row, sendNow });
    await db`update invoice_requests set sheet_error = '', email_status = case when ${out.sent === true} then 'SENT' else email_status end where id = ${id}`;
    return out;
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    await db`update invoice_requests set sheet_error = ${msg} where id = ${id}`;
    return { error: msg };
  }
}

async function oneRecord(db, id) {
  const [r] = await invoiceRecords(db, idOf(id));
  if (!r) throw new Bad('That invoice no longer exists. Refresh the page.');
  return r;
}

const DB_ACTIONS = {
  async request(db, me, body) {
    const r = body.request || {};
    const { invoiceType, client } = await requestBasics(db, r);
    let description, amount, attachments;
    if (Array.isArray(r.items)) {
      const items = cleanItems(r.items);
      description = items.map((it) => `${it.particulars} - ${rupees(it.amount)}`).join('\n');
      amount = r2(items.reduce((s, it) => s + it.amount, 0));
      attachments = items.map((it) => it.link).filter(Boolean);
    } else {
      description = text(r.description, 1000, true);
      amount = r2(Number(r.amount));
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) throw new Bad('Amount must be a number above 0');
      attachments = [driveLink(r.attachmentUrl, 'The attachment must be a Google Drive file link')].filter(Boolean);
    }
    const invoiceDate = date(r.invoiceDate);
    const [q] = await db`insert into invoice_requests (invoice_type, client, invoice_date, description, po_number, amount, attachments)
                         values (${invoiceType}, ${client}, ${invoiceDate}, ${description}, ${text(r.poNumber, 300) || 'N/A'}, ${amount}, ${attachments.join('\n')}) returning id`;
    const [x] = await db`insert into receivable_invoices (client, invoice_date, amount, due_date, invoice_type, status, bills, request_id, updated_by)
                         values (${client}, ${invoiceDate}, ${amount}, ${invoiceDate}::date + ${DUE_DAYS}::int, ${typeSentence(invoiceType)}, 'NEW_ENTRY',
                                 ${isReimbType(invoiceType) ? attachments.join('\n') : ''}, ${q.id}, ${me.id}) returning id`;
    if (r.draftId) await db`delete from reimb_requests where id = ${idOf(r.draftId)}`; // now a request
    const out = await pushRequest(db, q.id, r.sendNow === true);
    const sheetErr = (await pushExtract(db, x.id)) || out.error;
    if (sheetErr) return { notice: `Invoice requested and saved, but the sheet copy failed: ${sheetErr} Use Retry sheet sync in Manage Invoices; the Finance Team email goes out once it is in the sheet.` };
    if (out.sendError) return { notice: `Invoice requested, but the Finance Team email failed: ${out.sendError} It is retried every hour; don't request it again.` };
    return { notice: out.sent ? 'Invoice requested and emailed to the Finance Team' : 'Invoice requested. The Finance Team email goes out at the scheduled time.' };
  },

  async rowDraft(db, me, body) {
    const u = body.update || {};
    const withGst = u.withGst === '' || u.withGst == null ? null : r2(Number(u.withGst));
    if (withGst !== null && (!Number.isFinite(withGst) || withGst <= 0 || withGst > 1e10)) throw new Bad('Amount with GST must be a number above 0');
    const draft = {
      invoiceNumber: text(u.invoiceNumber, 50), pdfUrl: text(u.pdfUrl, 500), withGst, status: STATUSES.includes(String(u.status)) ? String(u.status) : 'NEW_ENTRY',
      receivedDate: DATE.test(String(u.receivedDate || '')) ? u.receivedDate : '',
      by: me.name || me.email, on: new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' }),
    };
    const done = await db`update receivable_invoices set draft = ${JSON.stringify(draft)} where id = ${idOf(u.id)} returning id`;
    if (!done.length) throw new Bad('That invoice no longer exists. Refresh the page.');
    return { notice: 'Saved as draft. The invoice is unchanged until you save it.' };
  },

  async deleteRowDraft(db, me, body) {
    await db`update receivable_invoices set draft = null where id = ${idOf(body.update?.id)}`;
    return { notice: 'Draft discarded' };
  },

  async update(db, me, body) {
    const u = body.update || {};
    const r = await oneRecord(db, u.id);
    const status = String(u.status || '');
    if (!STATUSES.includes(status)) throw new Bad('Unknown status');
    const pdfUrl = driveLink(u.pdfUrl, 'Paste the Google Drive link of the invoice PDF');
    const invoiceNumber = text(u.invoiceNumber, 50);
    let withGst = u.withGst === '' || u.withGst == null ? null : r2(Number(u.withGst));
    if (withGst !== null && (!Number.isFinite(withGst) || withGst <= 0 || withGst > 1e10)) throw new Bad('Amount with GST must be a number above 0');
    withGst = withGst ?? r.withGst; // left as is when not given
    const missing = readyMissing({ invoiceNumber, pdfUrl, withGst });
    if (['APPROVED', 'REMINDER'].includes(status) && missing.length) throw new Bad(`Add the ${missing.join(', ')} before choosing this status`);
    const toReceive = withGst > 0 ? toBeReceived(withGst, r.amount, isReimbType(r.invoiceType)) : r.toReceive;
    const received = status === 'Payment Received' ? date(u.receivedDate) : null;
    // The invoice date can change until the invoice is approved (the due date follows; so does an unsent Finance Team request).
    let invoiceDate = r.invoiceDateIso;
    const moved = Boolean(u.invoiceDate) && u.invoiceDate !== r.invoiceDateIso;
    if (moved) {
      if (r.status.toUpperCase() !== 'NEW_ENTRY') throw new Bad('The invoice date can only be changed until the invoice is approved');
      invoiceDate = date(u.invoiceDate);
    }
    await db`update receivable_invoices set invoice_number = ${invoiceNumber}, pdf_url = ${pdfUrl}, with_gst = ${withGst}, to_receive = ${toReceive},
               status = ${status}, received_date = ${received}, invoice_date = ${invoiceDate},
               due_date = case when ${moved} then coalesce(due_date + (${invoiceDate}::date - invoice_date), ${invoiceDate}::date + ${DUE_DAYS}::int) else due_date end,
               draft = null, updated_by = ${me.id}, updated_at = now() where id = ${r.id}`;
    if (moved) {
      await db`update plan_invoices set invoice_date = ${invoiceDate} where invoice_id = ${r.id}`;
      const req = r.requestId ? await db`update invoice_requests set invoice_date = ${invoiceDate} where id = ${r.requestId} and upper(email_status) <> 'SENT' returning id` : [];
      if (req.length) await pushRequest(db, r.requestId);
    }
    const sheetErr = await pushExtract(db, r.id);
    const bills = u.attachBills === true && status === 'APPROVED' ? await attachBillsDb(db, r.id, u.rebuildBills === true) : '';
    return { notice: 'Invoice saved' + bills + (sheetErr ? `. The sheet copy failed (${sheetErr}); use Retry sheet sync.` : '') };
  },

  async delete(db, me, body) {
    const r = await oneRecord(db, body.update?.id);
    if (r.status.toUpperCase() !== 'NEW_ENTRY') throw new Bad(`Only new entries can be deleted (this one is ${r.status})`);
    // the sheet first, so a Finance Team email can't go out for a deleted request
    let request = 'none';
    if (r.requestId) {
      const [q] = await db`select email_status from invoice_requests where id = ${r.requestId}`;
      if (q && q.email_status.toUpperCase() === 'SENT') request = 'sent';
      else if (q) { await script(db, { action: 'deleteRequest', id: r.requestId }); request = 'removed'; }
    }
    await script(db, { action: 'deleteExtract', id: r.id });
    await db`delete from receivable_invoices where id = ${r.id}`;
    if (request === 'removed') await db`delete from invoice_requests where id = ${r.requestId}`;
    return { notice: 'Invoice deleted.' + (request === 'removed' ? ' Its request to the Finance Team had not been emailed yet and is removed too.'
      : request === 'sent' ? ' The Finance Team was already emailed about it, so let them know it is cancelled.' : '') };
  },

  async send(db, me, body) {
    const r = await oneRecord(db, body.id);
    if (!['NEW_ENTRY', 'APPROVED'].includes(r.status.toUpperCase())) throw new Bad(`This invoice has already been emailed (status ${r.status})`);
    const missing = readyMissing(r);
    if (missing.length) throw new Bad(`Add the ${missing.join(', ')} first`);
    const row = screenRow(r);
    if (row.billCount && !row.billsAttached) throw new Bad('Approve this reimbursement invoice first so its bills are added to the PDF');
    const out = await script(db, { action: 'send', row: extractRow(r) });
    await db`update receivable_invoices set status = 'REMINDER', email_thread = ${String(out.thread || '')}, sheet_error = '', updated_by = ${me.id}, updated_at = now() where id = ${r.id}`;
    return { notice: 'Invoice emailed to the client. Reminders now follow the configured intervals.' };
  },

  // Writes every record whose sheet copy failed.
  async resync(db) {
    const ex = await db`select id from receivable_invoices where sheet_error <> ''`;
    const rq = await db`select id from invoice_requests where sheet_error <> ''`;
    let failed = 0;
    for (const { id } of rq) if ((await pushRequest(db, id)).error) failed++;
    for (const { id } of ex) if (await pushExtract(db, id)) failed++;
    const done = ex.length + rq.length - failed;
    return { notice: !ex.length && !rq.length ? 'Nothing waiting: the sheet is up to date.' : `${done} written to the sheet${failed ? `, ${failed} still failing (see the invoice)` : ''}.` };
  },

  // Catches up with emails the sheet's timers sent but couldn't report.
  async syncMail(db) {
    const st = await script(db, { action: 'mailStatus' });
    let n = 0;
    for (const x of st.extracts || []) {
      const id = Number(x.id);
      if (!Number.isInteger(id)) continue;
      const done = await db`update receivable_invoices set status = case when ${x.status.toUpperCase() === 'REMINDER'} and upper(status) in ('NEW_ENTRY', 'APPROVED') then 'REMINDER' else status end,
                                     email_thread = case when ${x.thread} <> '' then ${x.thread} else email_thread end
                            where id = ${id} and ((${x.status.toUpperCase() === 'REMINDER'} and upper(status) in ('NEW_ENTRY', 'APPROVED')) or (${x.thread} <> '' and email_thread <> ${x.thread})) returning id`;
      n += done.length;
    }
    for (const q of st.requests || []) {
      const id = Number(q.id);
      if (!Number.isInteger(id) || q.emailStatus.toUpperCase() !== 'SENT') continue;
      n += (await db`update invoice_requests set email_status = 'SENT' where id = ${id} and upper(email_status) <> 'SENT' returning id`).length;
    }
    return { notice: n ? `${n} email update(s) brought in from the sheet.` : 'Emails are up to date.' };
  },
};

// Approving a reimbursement invoice: the bills go into the PDF from page 2 (merged here, saved in Drive by the script).
async function attachBillsDb(db, id, rebuild) {
  try {
    const [r] = await invoiceRecords(db, id);
    const row = extractRow(r);
    const got = await script(db, { action: 'bills', row, force: rebuild });
    if (got.already) return '. The bills are already in the invoice PDF.';
    if (!got.bills?.length) return '. No bills were found for this reimbursement request, so the PDF is unchanged.';
    const { pdf, added, skipped } = await mergeBills(got.invoice, got.bills);
    if (pdf.length > MAX_EMAIL_PDF) return `, but the PDF with the bills would be ${Math.ceil(pdf.length / 1048576)} MB, over Gmail's 25 MB limit, so it is unchanged.`;
    const merged = fileId(r.withBills) && fileId(r.withBills) === fileId(r.pdfUrl) ? fileId(r.withBills) : null;
    const saved = await script(db, { action: 'saveMerged', baseId: got.baseId, previousMerged: merged, data: pdf.toString('base64') });
    await db`update receivable_invoices set pdf_url = ${saved.url}, pdf_with_bills = ${saved.url}, pdf_without_bills = ${saved.baseUrl} where id = ${id}`;
    await pushExtract(db, id);
    return `. ${added} bill(s) added to the invoice PDF from page 2${skipped ? `; ${skipped} could not be read (a note page stands in for each)` : ''}.`;
  } catch (e) {
    if (!(e instanceof Bad)) console.error(e);
    return `, but the bills could not be added to the PDF: ${e.message || 'unexpected error'}`;
  }
}

// The Apps Script timers report what they emailed.
async function mailed(db, body) {
  const id = idOf(body.id);
  if (body.kind === 'request') await db`update invoice_requests set email_status = 'SENT' where id = ${id}`;
  else if (body.kind === 'reminder' || body.kind === 'client') {
    await db`update receivable_invoices set email_thread = ${text(body.thread, 200)},
               status = case when upper(status) in ('NEW_ENTRY', 'APPROVED') then 'REMINDER' else status end where id = ${id}`;
  } else throw new Bad('Unknown kind');
  return { ok: true };
}

// One-time move: copies both sheet tabs into the database, writes each record's id into the sheet (AppId), then
// switches the app to the database. Safe to run again: rows that already carry an id are skipped.
async function importSheet(db, me) {
  if (me.role !== 'admin') throw new Bad('Only the admin can move Receivables to the database');
  let d;
  try {
    d = await script(db, { action: 'dump' });
  } catch (e) {
    if (/unknown action/i.test(e.message)) throw new Bad('The sheet still runs the old script. Paste the new script into the sheet and deploy it first (steps below), then try again.');
    throw e;
  }
  if (!Array.isArray(d.extracts) || !Array.isArray(d.requests)) throw new Bad('Paste the new script into the sheet and deploy it first (see the steps below).');
  const have = async (table, ids) => {
    const nums = ids.map(Number).filter(Number.isInteger);
    if (!nums.length) return new Set();
    const rows = table === 'r' ? await db`select id from invoice_requests where id = any(${nums}::int[])` : await db`select id from receivable_invoices where id = any(${nums}::int[])`;
    return new Set(rows.map((x) => String(x.id)));
  };
  const haveReq = await have('r', d.requests.map((x) => x.appId).filter(Boolean));
  const haveExt = await have('e', d.extracts.map((x) => x.appId).filter(Boolean));
  const newReq = d.requests.filter((x) => !haveReq.has(x.appId));
  const newExt = d.extracts.filter((x) => !haveExt.has(x.appId));
  const dt = (v) => (DATE.test(String(v || '')) ? v : null);
  const reqIds = newReq.length ? (await db.transaction(newReq.map((x) => db`
    insert into invoice_requests (invoice_type, client, category, invoice_date, description, po_number, amount, email_status, attachments, extra)
    values (${x.invoiceType || ''}, ${x.client}, ${x.category || ''}, ${dt(x.invoiceDate)}, ${x.description || ''}, ${x.poNumber || 'N/A'}, ${x.amount ?? 0},
            ${x.emailStatus || 'TO SEND'}, ${x.attachments || ''}, ${JSON.stringify(x.extra || {})}) returning id`))).map((r) => r[0].id) : [];
  // each invoice is linked to the request with the same client, invoice date and amount (its bills come from there)
  const allReq = await db`select id, lower(client) as client, to_char(invoice_date, 'YYYY-MM-DD') as d, amount::float8 as amount, attachments, invoice_type as type from invoice_requests`;
  const reqOf = (x) => allReq.find((q) => q.client === String(x.client).toLowerCase() && q.d === dt(x.invoiceDate) && Math.abs(q.amount - (x.amount ?? 0)) < 0.005);
  const extIds = newExt.length ? (await db.transaction(newExt.map((x) => {
    const q = reqOf(x);
    const bills = x.bills || (q && isReimbType(x.invoiceType) ? q.attachments : '');
    return db`insert into receivable_invoices (client, invoice_number, invoice_date, category, amount, with_gst, to_receive, due_date, pdf_url, status, email_thread,
                invoice_type, received_date, bills, pdf_without_bills, pdf_with_bills, extra, request_id, updated_by)
              values (${x.client}, ${x.invoiceNumber || ''}, ${dt(x.invoiceDate)}, ${x.category || ''}, ${x.amount ?? 0}, ${x.withGst}, ${x.toReceive}, ${dt(x.dueDate)},
                      ${x.pdfUrl || ''}, ${x.status || 'NEW_ENTRY'}, ${x.thread || ''}, ${x.invoiceType || ''}, ${dt(x.receivedDate)}, ${bills}, ${x.noBills || ''},
                      ${x.withBills || ''}, ${JSON.stringify(x.extra || {})}, ${q ? q.id : null}, ${me.id}) returning id`;
  }))).map((r) => r[0].id) : [];
  try {
    await script(db, { action: 'stamp', requests: newReq.map((x, i) => ({ row: x.row, client: x.client, id: reqIds[i] })),
      extracts: newExt.map((x, i) => ({ row: x.row, client: x.client, id: extIds[i] })) });
  } catch (e) {
    // nothing was stamped: take the copies back out so a second run doesn't duplicate them
    if (extIds.length) await db`delete from receivable_invoices where id = any(${extIds}::int[])`;
    if (reqIds.length) await db`delete from invoice_requests where id = any(${reqIds}::int[])`;
    throw e;
  }
  await setSetting(db, 'receivablesSource', 'db');
  return { notice: `Moved to the database: ${extIds.length} invoice(s) and ${reqIds.length} Finance Team request(s)${haveExt.size + haveReq.size ? ` (${haveExt.size + haveReq.size} were already in)` : ''}. Receivables now reads from the database.` };
}

// Reimbursement invoices reach the client with the request's bills from page 2 onwards. The Finance Team's PDF
// usually has no bills, so on approval the sheet script hands over the invoice and the bills, they are merged here,
// and the merged PDF is saved next to the invoice in Drive (the row's Invoice link then points at it).
const MAX_EMAIL_PDF = 24 * 1024 * 1024; // Gmail allows 25 MB of attachments
async function attachBills(db, row, client, rebuild) {
  try {
    const got = await script(db, { action: 'bills', row, client, force: rebuild });
    if (got.already) return '. The bills are already in the invoice PDF.';
    if (!got.bills?.length) return '. No bills were found for this reimbursement request, so the PDF is unchanged.';
    const { pdf, added, skipped } = await mergeBills(got.invoice, got.bills);
    if (pdf.length > MAX_EMAIL_PDF) return `, but the PDF with the bills would be ${Math.ceil(pdf.length / 1048576)} MB, over Gmail's 25 MB limit, so it is unchanged.`;
    await script(db, { action: 'saveMerged', row, client, baseId: got.baseId, currentId: got.currentId, data: pdf.toString('base64') });
    return `. ${added} bill(s) added to the invoice PDF from page 2${skipped ? `; ${skipped} could not be read (a note page stands in for each)` : ''}.`;
  } catch (e) {
    if (!(e instanceof Bad)) console.error(e);
    return `, but the bills could not be added to the PDF: ${e.message || 'unexpected error'}`;
  }
}

// invoice / bills: { name, type, data (base64) } from the sheet script; a bill may instead carry { name, error }.
export async function mergeBills(invoice, bills) {
  let doc;
  try {
    doc = await PDFDocument.load(Buffer.from(invoice.data, 'base64'), { ignoreEncryption: true });
  } catch {
    throw new Bad("Can't read the invoice PDF");
  }
  const A4 = [595.28, 841.89];
  const M = 36;
  let font;
  let added = 0, skipped = 0;
  for (const [n, b] of bills.entries()) {
    try {
      if (b.error) throw new Error(b.error);
      const buf = Buffer.from(b.data, 'base64');
      if (/pdf/i.test(b.type)) {
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
      } else {
        const img = /png/i.test(b.type) ? await doc.embedPng(buf) : await doc.embedJpg(buf);
        const scale = Math.min((A4[0] - 2 * M) / img.width, (A4[1] - 2 * M) / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        doc.addPage(A4).drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
      }
      added++;
    } catch (e) {
      skipped++;
      font ||= await doc.embedFont(StandardFonts.Helvetica);
      const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 95);
      const page = doc.addPage(A4);
      page.drawText(ascii(`Bill ${n + 1}: ${b.name || ''}`), { x: M, y: A4[1] - M - 20, size: 13, font });
      page.drawText(ascii(`This bill could not be included. ${e.message || ''}`), { x: M, y: A4[1] - M - 44, size: 10, font });
    }
  }
  return { pdf: Buffer.from(await doc.save()), added, skipped };
}

const rupees = (n) => '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

async function requestBasics(db, r) {
  const config = await readConfig(db);
  const invoiceType = text(r.invoiceType, 50, true);
  if (!config.invoiceTypes.includes(invoiceType)) throw new Bad('Unknown invoice type');
  const [client] = await db`select name from clients where name = ${text(r.client, 200, true)}`;
  if (!client) throw new Bad('Pick a client from the list');
  return { invoiceType, client: client.name };
}

// Reimbursement rows: { date (when added), particulars, amount, link (optional Drive bill) }
export function cleanItems(items, today = todayIST()) {
  if (!Array.isArray(items) || !items.length) throw new Bad('Add at least one row');
  if (items.length > 50) throw new Bad('Up to 50 rows per request');
  return items.map((it, n) => {
    const particulars = text(it?.particulars, 300);
    const amount = Math.round(Number(it?.amount) * 100) / 100;
    if (!particulars || !Number.isFinite(amount) || amount <= 0 || amount > 1e10) throw new Bad(`Row ${n + 1}: add the particulars and an amount above 0`);
    const d = String(it?.date || '');
    return { date: DATE.test(d) && d <= today ? d : today, particulars, amount, link: driveLink(it?.link, `Row ${n + 1}: the bill must be a Google Drive file link`) };
  });
}

// Saves a pending reimbursement request (one open per client); returns its id.
async function saveDraft(db, me, r) {
  const { invoiceType, client } = await requestBasics(db, r);
  const items = JSON.stringify(cleanItems(r.items));
  const po = text(r.poNumber, 300);
  if (r.draftId) {
    const rows = await db`update reimb_requests set invoice_type = ${invoiceType}, po_number = ${po}, items = ${items}, updated_by = ${me.id}, updated_at = now()
                          where id = ${idOf(r.draftId)} and lower(client) = lower(${client}) returning id`;
    if (!rows.length) throw new Bad('That pending request was already submitted or deleted. Refresh the page.');
    return rows[0].id;
  }
  const rows = await db`insert into reimb_requests (client, invoice_type, po_number, items, updated_by) values (${client}, ${invoiceType}, ${po}, ${items}, ${me.id})
                        on conflict do nothing returning id`;
  if (!rows.length) throw new Bad(`${client} already has a pending reimbursement request. Continue it from Manage Invoices.`);
  return rows[0].id;
}

// Optional Google Drive file link (the Apps Script reads the file by its id).
function driveLink(v, message) {
  const url = text(v, 500);
  if (url && !/^https:\/\/(drive|docs)\.google\.com\/.*[-\w]{25,}/.test(url)) throw new Bad(message);
  return url;
}

// What an invoice still needs before it can be Approved or Emailed.
export const readyMissing = ({ invoiceNumber, pdfUrl, withGst }) => [
  !invoiceNumber && 'invoice number', !pdfUrl && 'invoice PDF Google Drive link', !(withGst > 0) && 'amount with GST',
].filter(Boolean);

function idOf(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Bad('Invalid id');
  return n;
}

function rowNo(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2) throw new Bad('Invalid sheet row');
  return n;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const db = sql();
  // The Apps Script reads the settings and the address book with the shared key (no login).
  if (req.method === 'GET' && req.query.key !== undefined) {
    if (req.query.key !== invoiceToken()) return res.status(403).json({ error: 'Wrong key: copy the script again from Receivables, Automator Settings' });
    return res.status(200).json({ config: await readConfig(db), clients: await readClients(db) });
  }
  // The Apps Script timers report the emails they sent (db mode), with the same key.
  if (req.method === 'POST' && req.body?.key !== undefined) {
    if (req.body.key !== invoiceToken()) return res.status(403).json({ error: 'Wrong key' });
    try {
      if (req.body.action !== 'mailed') return res.status(400).json({ error: 'Unknown action' });
      return res.status(200).json(await mailed(db, req.body));
    } catch (e) {
      if (e instanceof Bad) return res.status(400).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: 'Server error' });
    }
  }
  const me = await requireUser(req, res);
  if (!me) return;
  if (!isFinanceAdmin(me)) return res.status(403).json({ error: 'Only Admin and Finance Admin can use the Client Invoice Automator' });
  try {
    if (req.method === 'GET' && req.query.rows) {
      if (await isDb(db)) return res.status(200).json({ rows: (await invoiceRecords(db)).map(screenRow) });
      return res.status(200).json(await script(db, { action: 'list' }));
    }
    let notice;
    if (req.method === 'POST') notice = (await act(db, me, req.body)).notice;
    else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const admin = me.role === 'admin';
    const dbMode = await isDb(db);
    const [waiting] = dbMode ? await db`select (select count(*) from receivable_invoices where sheet_error <> '') + (select count(*) from invoice_requests where sheet_error <> '') as n` : [{ n: 0 }];
    return res.status(200).json({
      dbMode, sheetWaiting: Number(waiting.n),
      config: await readConfig(db), clients: await readClients(db), drafts: await readDrafts(db), rowDrafts: await readRowDrafts(db), notice,
      script: admin ? await getSetting(db, 'invoiceScript') : undefined, key: admin ? invoiceToken() : undefined,
    });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
