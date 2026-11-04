// Single sign-on into the Project Tracker (a separate app with its own login).
// GET [?embed=1]           -> signed-in user is sent to the Project Tracker with a one-time pass
//                             (embed: shown inside this app's Projects page)
// GET ?view=links          -> admin: Project Tracker owners, with the login each is linked to
// POST {ownerId, userId}   -> admin: link an owner to a login (userId empty = unlink)
import { createHmac, randomBytes } from 'node:crypto';
import { sql, getCookie, readSession, requireUser } from './_lib.js';

export const PT_URL = (process.env.PT_URL || 'https://simis-project-tracker.vercel.app').replace(/\/+$/, '');
const PASS_SECONDS = 60;

// base64url(JSON payload) + "." + HMAC-SHA256 hex, checked by the Project Tracker's /api/auth?sso=
export function makePass(payload, secret = process.env.PT_SSO_SECRET, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ v: 1, ...payload, exp: Math.floor(now / 1000) + PASS_SECONDS, n: randomBytes(16).toString('hex') })).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function ptOwners() {
  const res = await fetch(`${PT_URL}/api/auth?owners=1`, { headers: { 'x-sso-key': process.env.PT_SSO_SECRET } });
  if (!res.ok) throw new Error(`The Project Tracker answered ${res.status}. Check PT_SSO_SECRET is set on both apps.`);
  return (await res.json()).owners || [];
}

function page(res, status, message) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const safe = String(message).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  res.status(status).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Project Tracker</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1a1a1a;background:#fff">
<h1 style="font-size:1.25rem">Can't open the Project Tracker</h1><p>${safe}</p><p><a href="/payouts.html">Back to Invincible YOU</a></p></body>`);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.PT_SSO_SECRET) return page(res, 503, 'Single sign-on is not set up yet (PT_SSO_SECRET is missing).');
  const db = sql();

  if (req.method === 'GET' && !req.query.view) {
    // Not signed in here: sign in first, then come back.
    const userId = readSession(getCookie(req, 'sid'));
    const [me] = userId ? await db`select id, role, active, coalesce(nullif(name, ''), nullif(profile->>'name', ''), email) as name from users where id = ${userId}` : [];
    if (!me) {
      res.setHeader('Location', '/payouts.html?next=project-tracker');
      return res.status(302).end();
    }
    if (!me.active) return page(res, 403, 'This login has been deactivated. Please contact the admin.');
    const ownerIds = (await db`select owner_id from pt_owner_links where user_id = ${me.id} order by owner_name`).map((r) => r.owner_id);
    if (!['admin', 'management'].includes(me.role) && !ownerIds.length) {
      return page(res, 403, 'Your login is not linked to a Project Tracker owner yet. Ask the admin to link it (Settings, Project Tracker owners).');
    }
    res.setHeader('Referrer-Policy', 'no-referrer');
    const pass = makePass({ uid: me.id, name: me.name, role: me.role, ownerIds, embed: req.query.embed === '1' });
    res.setHeader('Location', `${PT_URL}/api/auth?sso=${pass}`);
    return res.status(302).end();
  }

  const me = await requireUser(req, res, ['admin']);
  if (!me) return;
  try {
    if (req.method === 'POST') {
      const ownerId = String(req.body?.ownerId || '');
      if (!/^[\w-]{1,64}$/.test(ownerId)) return res.status(400).json({ error: 'Invalid owner' });
      const userId = req.body?.userId ? Number(req.body.userId) : null;
      if (userId !== null && !Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid login' });
      const owner = (await ptOwners()).find((o) => o.id === ownerId);
      if (!owner) return res.status(400).json({ error: 'That owner no longer exists in the Project Tracker' });
      if (userId === null) await db`delete from pt_owner_links where owner_id = ${ownerId}`;
      else {
        const [u] = await db`select id from users where id = ${userId}`;
        if (!u) return res.status(400).json({ error: 'Login not found' });
        // a login links to one owner: moving it frees its previous owner
        await db.transaction([
          db`delete from pt_owner_links where user_id = ${userId} and owner_id <> ${ownerId}`,
          db`insert into pt_owner_links (owner_id, owner_name, user_id) values (${ownerId}, ${owner.name}, ${userId})
             on conflict (owner_id) do update set user_id = excluded.user_id, owner_name = excluded.owner_name`,
        ]);
      }
    } else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const [owners, links] = await Promise.all([ptOwners(), db`select owner_id as "ownerId", user_id as "userId" from pt_owner_links`]);
    const byOwner = Object.fromEntries(links.map((l) => [l.ownerId, l.userId]));
    return res.status(200).json({ owners: owners.map((o) => ({ ...o, userId: byOwner[o.id] ?? null })) });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: e.message || 'Could not reach the Project Tracker' });
  }
}
