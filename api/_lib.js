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

export async function requireUser(req, res) {
  const userId = readSession(getCookie(req, 'sid'));
  if (!userId) {
    res.status(401).json({ error: 'Please sign in' });
    return null;
  }
  const rows = await sql()`select id, email from users where id = ${userId}`;
  if (!rows.length) {
    res.status(401).json({ error: 'Please sign in' });
    return null;
  }
  return rows[0];
}
