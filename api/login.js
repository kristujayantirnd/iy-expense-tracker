import { sql, verifyPassword, makeSession, sessionCookie, SESSION_MAX_AGE } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const rows = await sql()`select id, role, password_hash from users where email = ${email}`;
  if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  res.setHeader('Set-Cookie', sessionCookie(makeSession(rows[0].id), SESSION_MAX_AGE));
  res.status(200).json({ ok: true, email, role: rows[0].role });
}
