// Client Invoice Automator. Clients and settings live here; the invoice rows stay in the sheet
// (RequestInvoice, Invoice Extracts) and emails go out from Gmail, both through the sheet's
// Apps Script (InvoiceAutomator.gs). Only Admin and Finance Admin use it.
// GET ?key=…            -> the Apps Script: { config, clients }
// GET                   -> { config, clients, script, key (admin) }
// GET ?rows=1           -> { rows } from Invoice Extracts
// POST {action, …}      -> config | client | import | draft | deleteDraft | request | update | send | script (admin)
import { sql, requireUser, isFinanceAdmin, invoiceToken } from './_lib.js';
import { SCRIPT_URL } from './_pdf.js';

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
    case 'update': {
      const u = body.update || {};
      const status = String(u.status || '');
      if (!STATUSES.includes(status)) throw new Bad('Unknown status');
      const pdfUrl = driveLink(u.pdfUrl, 'Paste the Google Drive link of the invoice PDF');
      await script(db, {
        action: 'update', row: rowNo(u.row), client: text(u.client, 200, true), invoiceNumber: text(u.invoiceNumber, 50), pdfUrl, status,
        receivedDate: status === 'Payment Received' ? date(u.receivedDate) : '',
      });
      return { notice: 'Invoice updated in the sheet' };
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
  const me = await requireUser(req, res);
  if (!me) return;
  if (!isFinanceAdmin(me)) return res.status(403).json({ error: 'Only Admin and Finance Admin can use the Client Invoice Automator' });
  try {
    if (req.method === 'GET' && req.query.rows) return res.status(200).json(await script(db, { action: 'list' }));
    let notice;
    if (req.method === 'POST') notice = (await act(db, me, req.body)).notice;
    else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const admin = me.role === 'admin';
    return res.status(200).json({
      config: await readConfig(db), clients: await readClients(db), drafts: await readDrafts(db), notice,
      script: admin ? await getSetting(db, 'invoiceScript') : undefined, key: admin ? invoiceToken() : undefined,
    });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
