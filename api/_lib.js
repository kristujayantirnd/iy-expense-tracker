// Shared helpers. Files starting with "_" are not exposed as API routes by Vercel.
import { neon } from '@neondatabase/serverless';
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

export const sql = () => neon(process.env.DATABASE_URL);

const SESSION_DAYS = 7;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// Cookie value: "<userId>.<expiryMs>.<hmac>" — stateless, tamper-proof without the secret.
export function makeSession(userId, secret = process.env.SESSION_SECRET, now = Date.now()) {
  const payload = `${userId}.${now + SESSION_DAYS * 864e5}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function readSession(value, secret = process.env.SESSION_SECRET, now = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3 || !secret) return null;
  const [userId, exp, mac] = parts;
  const expected = sign(`${userId}.${exp}`, secret);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  if (Number(exp) < now) return null;
  return Number(userId);
}

export function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function sessionCookie(value, maxAgeSec) {
  return `sid=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

// roles: allowed roles; omit to allow any signed-in user.
export async function requireUser(req, res, roles) {
  const userId = readSession(getCookie(req, 'sid'));
  const rows = userId
    ? await sql()`select id, email, name, role, salary::float8 as salary, profile from users where id = ${userId}`
    : [];
  if (!rows.length) {
    res.status(401).json({ error: 'Please sign in' });
    return null;
  }
  if (roles && !roles.includes(rows[0].role)) {
    res.status(403).json({ error: 'You do not have access to this', role: rows[0].role });
    return null;
  }
  return rows[0];
}

// Secret for the Google Sheets IMPORTDATA link. shortcut: derived from SESSION_SECRET, so it only changes if that does.
export const sheetToken = (secret = process.env.SESSION_SECRET) => sign('payout-sheet', secret);
// Shared secret the Google Apps Script checks before saving a PDF into Drive.
export const driveToken = (secret = process.env.SESSION_SECRET) => sign('drive-copy', secret);

export const TDS_RATE = 0.1;
const round2 = (n) => Math.round(n * 100) / 100;

// Approved invoices -> one payout row per employee per month: net salary (after 10% TDS) + reimbursements.
// invoices: [{ userId, name, email, kind, date: 'YYYY-MM-DD', total }]
export function buildRegister(invoices) {
  const rows = new Map();
  for (const inv of invoices) {
    const month = inv.date.slice(0, 7);
    const key = `${month}|${inv.userId}`;
    if (!rows.has(key)) rows.set(key, { month, userId: inv.userId, name: inv.name, email: inv.email, salary: 0, reimbursement: 0 });
    rows.get(key)[inv.kind === 'salary' ? 'salary' : 'reimbursement'] += Number(inv.total);
  }
  return [...rows.values()]
    .map((r) => {
      const tds = round2(r.salary * TDS_RATE);
      const netSalary = round2(r.salary - tds);
      const reimbursement = round2(r.reimbursement);
      return { ...r, salary: round2(r.salary), tds, netSalary, reimbursement, payout: round2(netSalary + reimbursement) };
    })
    .sort((a, b) => a.month.localeCompare(b.month) || a.name.localeCompare(b.name));
}

// Text starting with = + - @ is prefixed with ' so spreadsheets don't run it as a formula.
export async function registerRows(db, from, to) {
  const invoices = await db`select i.user_id as "userId", i.kind, to_char(i.invoice_date, 'YYYY-MM-DD') as date, i.total::float8 as total,
                                   u.email, coalesce(nullif(u.name, ''), nullif(u.profile->>'name', ''), u.email) as name
                            from invoices i join users u on u.id = i.user_id
                            where i.status = 'approved' and i.invoice_date between ${from} and ${to}`;
  return buildRegister(invoices);
}

const csvCell = (v) =>
  typeof v === 'number' ? String(v) : `"${String(v ?? '').replace(/^[=+\-@]/, "'$&").replace(/"/g, '""')}"`;
export const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

export const REGISTER_HEADER = ['Month', 'Employee', 'Email', 'Gross Salary', 'TDS (10%)', 'Net Salary', 'Reimbursements', 'Payout'];
export const registerCsv = (rows) =>
  toCsv([REGISTER_HEADER, ...rows.map((r) => [r.month, r.name, r.email, r.salary, r.tds, r.netSalary, r.reimbursement, r.payout])]);
