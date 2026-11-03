// CSV of the payout register for Google Sheets: =IMPORTDATA("https://<site>/api/payout-sheet?token=...")
// Optional &month=YYYY-MM; default is every month.
import { timingSafeEqual } from 'node:crypto';
import { sql, sheetToken, registerRows, registerCsv } from './_lib.js';

export default async function handler(req, res) {
  const token = String(req.query.token || '');
  const expected = sheetToken();
  if (!process.env.SESSION_SECRET || token.length !== expected.length || !timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).send('Invalid link');
  }
  const month = String(req.query.month || '');
  let from = '2000-01-01', to = '2999-12-31';
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).send('month must be YYYY-MM');
    const [y, m] = month.split('-').map(Number);
    from = `${month}-01`;
    to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(registerCsv(await registerRows(sql(), from, to)));
}
