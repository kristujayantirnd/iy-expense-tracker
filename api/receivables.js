// Receivables dashboard. Admin, Management and Finance Admin can read it.
// Reads the database once Receivables has been moved there (settings.receivablesSource = 'db'); until then the
// invoice & receivables Google Sheet through its Apps Script (getDashboardData).
// GET             -> { invoices, source }
// GET ?compare=1  -> admin: dashboard totals from the database and from the sheet, side by side
// GET ?config=1   -> admin: { script, key } for Settings
// POST {script}   -> admin: save the dashboard Apps Script web app link
import { sql, requireUser, receivablesToken, isFinanceAdmin } from './_lib.js';
import { invoiceRecords, isReimbType } from './client-invoices.js';

const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
const dmy = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

// The dashboard's view of an invoice: received, upcoming (not raised to the client yet: a new entry or no invoice
// number) or receivable. Every dashboard amount is the amount without GST (the amount with GST shows only in
// Manage Invoices' Amount Receivable column).
export function dashboardRow(r) {
  const status = String(r.status || '').trim();
  const isReceived = status.toLowerCase() === 'payment received';
  const isUpcoming = !isReceived && (!String(r.invoiceNumber || '').trim() || status.toUpperCase() === 'NEW_ENTRY');
  const type = String(r.invoiceType || '');
  return {
    client: r.client, invoiceNumber: r.invoiceNumber, invoiceDate: dmy(r.invoiceDateIso), dueDate: dmy(r.dueDateIso), dueDateIso: r.dueDateIso || '', invoiceDateIso: r.invoiceDateIso || '',
    amtReceivable: r.amount || 0, isUpcoming, isReceived, pdfLink: r.pdfUrl || '', rawStatus: status,
    invoiceCategory: isReimbType(type) ? 'reimbursement' : /service/i.test(type) ? 'service' : 'other',
  };
}

const totals = (list) => {
  const t = { total: 0, received: 0, pending: 0, upcoming: 0, count: list.length, countReceived: 0, countPending: 0, countUpcoming: 0 };
  for (const i of list) {
    t.total += i.amtReceivable;
    if (i.isUpcoming) { t.upcoming += i.amtReceivable; t.countUpcoming++; } else if (i.isReceived) { t.received += i.amtReceivable; t.countReceived++; } else { t.pending += i.amtReceivable; t.countPending++; }
  }
  for (const k of ['total', 'received', 'pending', 'upcoming']) t[k] = Math.round(t[k] * 100) / 100;
  return t;
};

async function fromSheet(script) {
  if (!script) throw new Error('Receivables is not set up yet. The admin adds the Apps Script link in Settings (gear icon).');
  const r = await fetch(`${script}?format=json&key=${receivablesToken()}`, { redirect: 'follow' });
  const out = await r.json().catch(() => null);
  if (!out) throw new Error(`The Apps Script answered with HTTP ${r.status}. Check it is deployed as Execute as: Me, Who has access: Anyone.`);
  if (out.error) throw new Error(out.error);
  return Array.isArray(out.invoices) ? out.invoices : [];
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = await requireUser(req, res);
  if (!me) return;
  if (me.role !== 'management' && !isFinanceAdmin(me)) return res.status(403).json({ error: 'You do not have access to this' });
  const db = sql();
  const settings = Object.fromEntries((await db`select key, value from settings where key in ('receivablesScript', 'receivablesSource')`).map((r) => [r.key, r.value]));
  const script = settings.receivablesScript || '';
  const dbMode = settings.receivablesSource === 'db';

  if (req.query.config || req.method === 'POST') {
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only the admin can change Receivables settings' });
    if (req.method === 'POST') {
      const next = String(req.body?.script || '').trim();
      if (next && !SCRIPT_URL.test(next)) return res.status(400).json({ error: 'The script link must look like https://script.google.com/macros/s/…/exec' });
      await db`insert into settings (key, value) values ('receivablesScript', ${next}) on conflict (key) do update set value = excluded.value`;
      return res.status(200).json({ script: next, key: receivablesToken() });
    }
    return res.status(200).json({ script, key: receivablesToken() });
  }

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (req.query.compare) {
      if (me.role !== 'admin') return res.status(403).json({ error: 'Only the admin can compare' });
      const fromDb = (await invoiceRecords(db)).map(dashboardRow);
      let sheet = null, sheetError = '';
      try { sheet = totals(await fromSheet(script)); } catch (e) { sheetError = e.message || String(e); }
      return res.status(200).json({ db: totals(fromDb), sheet, sheetError });
    }
    if (dbMode) return res.status(200).json({ invoices: (await invoiceRecords(db)).map(dashboardRow), source: 'db' });
    return res.status(200).json({ invoices: await fromSheet(script), source: 'sheet' });
  } catch (e) {
    return res.status(502).json({ error: (dbMode ? 'Could not read the receivables: ' : 'Could not read the Receivables sheet: ') + (e.message || e) });
  }
}
