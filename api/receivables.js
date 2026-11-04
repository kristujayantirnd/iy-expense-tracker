// Receivables module: the company's invoice & receivables Google Sheet, read through its Apps Script
// (getDashboardData). The sheet stays the backend; only Admin and Management can read it here.
// GET            -> { invoices } from the sheet
// GET ?config=1  -> admin: { script, key } for Settings
// POST {script}  -> admin: save the Apps Script web app link
import { sql, requireUser, receivablesToken } from './_lib.js';

const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = await requireUser(req, res, ['admin', 'management']);
  if (!me) return;
  const db = sql();
  const [row] = await db`select value from settings where key = 'receivablesScript'`;
  const script = row?.value || '';

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
  if (!script) return res.status(503).json({ error: 'Receivables is not set up yet. The admin adds the Apps Script link in Settings (gear icon).' });
  try {
    const r = await fetch(`${script}?format=json&key=${receivablesToken()}`, { redirect: 'follow' });
    const out = await r.json().catch(() => null);
    if (!out) throw new Error(`The Apps Script answered with HTTP ${r.status}. Check it is deployed as Execute as: Me, Who has access: Anyone.`);
    if (out.error) throw new Error(out.error);
    return res.status(200).json({ invoices: Array.isArray(out.invoices) ? out.invoices : [] });
  } catch (e) {
    return res.status(502).json({ error: 'Could not read the Receivables sheet: ' + (e.message || e) });
  }
}
