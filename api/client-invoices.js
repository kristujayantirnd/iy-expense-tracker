// Client Invoice Automator. Clients and settings live here; the invoice rows stay in the sheet
// (RequestInvoice, Invoice Extracts) and emails go out from Gmail, both through the sheet's
// Apps Script (InvoiceAutomator.gs). Only Admin and Finance Admin use it.
// GET ?key=…            -> the Apps Script: { config, clients }
// GET                   -> { config, clients, script, key (admin) }
// GET ?rows=1           -> { rows } from Invoice Extracts
// POST {action, …}      -> config | client | import | request | update | send | script (admin)
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
    case 'request': {
      const r = body.request || {};
      const config = await readConfig(db);
      const invoiceType = text(r.invoiceType, 50, true);
      if (!config.invoiceTypes.includes(invoiceType)) throw new Bad('Unknown invoice type');
      const [client] = await db`select name from clients where name = ${text(r.client, 200, true)}`;
      if (!client) throw new Bad('Pick a client from the list');
      const amount = Math.round(Number(r.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e10) throw new Bad('Amount must be a number above 0');
      const out = await script(db, {
        action: 'request', invoiceType, client: client.name, invoiceDate: date(r.invoiceDate), poNumber: text(r.poNumber, 300) || 'N/A',
        description: text(r.description, 1000, true), amount, sendNow: r.sendNow === true,
      });
      return { notice: out.sent ? 'Invoice requested and emailed to the Finance Team' : 'Invoice requested. The Finance Team email goes out at the scheduled time.' };
    }
    case 'update': {
      const u = body.update || {};
      const status = String(u.status || '');
      if (!STATUSES.includes(status)) throw new Bad('Unknown status');
      const pdfUrl = text(u.pdfUrl, 500);
      if (pdfUrl && !/^https:\/\/(drive|docs)\.google\.com\/.*[-\w]{25,}/.test(pdfUrl)) throw new Bad('Paste the Google Drive link of the invoice PDF');
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
      config: await readConfig(db), clients: await readClients(db), notice,
      script: admin ? await getSetting(db, 'invoiceScript') : undefined, key: admin ? invoiceToken() : undefined,
    });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
