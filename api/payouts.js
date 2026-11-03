import { sql, requireUser, hashPassword, verifyPassword, registerRows, sheetToken } from './_lib.js';

const ROLES = ['admin', 'employee', 'management'];
const EMPLOYER_FIELDS = ['companyName', 'accountNumber', 'bank', 'ifsc', 'micr', 'bankAddress', 'gstin', 'pan'];
const PROFILE_FIELDS = ['name', 'address', 'phone', 'accountNumber', 'branch', 'bank', 'ifsc', 'pan'];
const SIGNATURE = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

class Bad extends Error {}
const text = (v, max = 200, required = false) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new Bad('Required field is empty');
  if (s.length > max) throw new Bad('Text is too long');
  return s;
};
const money = (v) => {
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0 || n > 1e10) throw new Bad('Amount must be a number above 0');
  return n;
};
const intId = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Bad('Invalid id');
  return n;
};
const date = (v) => {
  const s = String(v || '');
  if (!DATE.test(s) || Number.isNaN(Date.parse(s))) throw new Bad('Pick a valid date');
  return s;
};
const pick = (obj, fields, max) => Object.fromEntries(fields.map((f) => [f, text(obj?.[f], max)]));

const getEmployer = async (db) => {
  const rows = await db`select value from settings where key = 'employer'`;
  return rows.length ? JSON.parse(rows[0].value) : {};
};

// List queries leave out signatures (large); a single invoice includes them for printing.
async function readState(db, me) {
  const all = me.role !== 'employee';
  const [invoices, users] = await db.transaction([
    db`select i.id, i.user_id as "userId", i.kind, i.number, to_char(i.invoice_date, 'YYYY-MM-DD') as date, i.items,
              i.total::float8 as total, i.status, i.note, u.email, coalesce(nullif(u.name, ''), nullif(u.profile->>'name', ''), u.email) as name
       from invoices i join users u on u.id = i.user_id
       where ${all} or i.user_id = ${me.id}
       order by i.invoice_date desc, i.id desc`,
    all
      ? db`select id, email, role, salary::float8 as salary, coalesce(nullif(name, ''), profile->>'name', '') as name from users order by role, 5, email`
      : db`select 1 where false`,
  ]);
  const { signature, ...profile } = me.profile || {};
  return {
    me: { id: me.id, email: me.email, name: me.name, role: me.role, salary: me.salary, profile, hasSignature: Boolean(signature) },
    employer: await getEmployer(db),
    invoices,
    users: all ? users : [],
    sheetToken: me.role === 'admin' ? sheetToken() : undefined,
  };
}

async function saveInvoice(db, me, body) {
  if (!me.profile?.name) throw new Bad('Fill in your profile before raising an invoice');
  const invoiceDate = date(body.date);
  let kind = body.kind;
  let existing = null;
  if (body.id) {
    [existing] = await db`select kind, status from invoices where id = ${intId(body.id)} and user_id = ${me.id}`;
    if (!existing) throw new Bad('Invoice not found');
    if (existing.status === 'approved') throw new Bad('This invoice is approved and can no longer be edited');
    kind = existing.kind;
  }

  let items;
  if (kind === 'salary') {
    if (!(me.salary > 0)) throw new Bad('Your salary has not been set by the admin yet');
    const [y, m] = invoiceDate.split('-');
    items = [{ particulars: `Salary for ${MONTHS[Number(m) - 1]} ${y}`, amount: me.salary }];
  } else if (kind === 'reimbursement') {
    if (!Array.isArray(body.items) || !body.items.length) throw new Bad('Add at least one line item');
    if (body.items.length > 50) throw new Bad('Too many line items');
    items = body.items.map((it) => ({ particulars: text(it?.particulars, 300, true), amount: money(it?.amount) }));
  } else throw new Bad('Unknown invoice type');

  const total = Math.round(items.reduce((s, it) => s + it.amount * 100, 0)) / 100;
  const employer = JSON.stringify(await getEmployer(db));
  const employee = JSON.stringify({ ...me.profile, email: me.email });
  const itemsJson = JSON.stringify(items);
  try {
    if (existing) {
      // Editing (pending or rejected) sends it back for approval.
      const rows = await db`update invoices set invoice_date = ${invoiceDate}, items = ${itemsJson}, total = ${total},
                              employer = ${employer}, employee = ${employee}, status = 'pending', note = ''
                            where id = ${intId(body.id)} and user_id = ${me.id} and status <> 'approved' returning id`;
      if (!rows.length) throw new Bad('This invoice is approved and can no longer be edited');
    } else {
      // Max + 1 (not a sequence) so failed submissions never leave gaps; unique (kind, number) catches races.
      await db`insert into invoices (user_id, kind, number, invoice_date, items, total, employer, employee)
               select ${me.id}, ${kind}, coalesce(max(number), 0) + 1, ${invoiceDate}, ${itemsJson}, ${total}, ${employer}, ${employee}
               from invoices where kind = ${kind}`;
    }
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'one_salary_invoice_per_month') throw new Bad('You already have a salary invoice for that month');
    if (e.code === '23505') throw new Bad('Someone submitted at the same moment, please submit again');
    throw e;
  }
}

async function act(db, me, body) {
  const admin = me.role === 'admin';
  switch (body?.action) {
    case 'profile': {
      const profile = pick(body.profile, PROFILE_FIELDS, 300);
      if (!profile.name) throw new Bad('Name is required');
      let signature = body.profile?.signature;
      if (signature === undefined) signature = me.profile?.signature || ''; // not re-sent = keep the current one
      if (signature && (!SIGNATURE.test(signature) || signature.length > 400_000)) throw new Bad('Signature must be a PNG or JPG under 300 KB');
      return db`update users set profile = ${JSON.stringify({ ...profile, signature })} where id = ${me.id}`;
    }
    case 'invoice':
      return saveInvoice(db, me, body);
    case 'password': {
      const next = String(body.newPassword || '');
      if (next.length < 8) throw new Bad('New password must be at least 8 characters');
      const [row] = await db`select password_hash from users where id = ${me.id}`;
      if (!verifyPassword(String(body.currentPassword || ''), row.password_hash)) throw new Bad('Current password is wrong');
      return db`update users set password_hash = ${hashPassword(next)} where id = ${me.id}`;
    }
    case 'employer':
      if (!admin) throw new Bad('Only the admin can change employer details');
      return db`insert into settings (key, value) values ('employer', ${JSON.stringify(pick(body.employer, EMPLOYER_FIELDS, 300))})
                on conflict (key) do update set value = excluded.value`;
    case 'decide': {
      if (!admin) throw new Bad('Only the admin can approve invoices');
      if (!['approved', 'rejected'].includes(body.status)) throw new Bad('Unknown decision');
      const rows = await db`update invoices set status = ${body.status}, note = ${text(body.note, 500)}, decided_by = ${me.id}, decided_at = now()
                            where id = ${intId(body.id)} and status = 'pending' returning id`;
      if (!rows.length) throw new Bad('Only pending invoices can be approved or rejected');
      return;
    }
    case 'user': {
      if (!admin) throw new Bad('Only the admin can manage logins');
      const u = body.user || {};
      if (!ROLES.includes(u.role)) throw new Bad('Unknown role');
      const salary = Number(u.salary || 0);
      if (!Number.isFinite(salary) || salary < 0 || salary > 1e10) throw new Bad('Salary must be a positive number');
      const password = String(u.password || '');
      if (password && password.length < 8) throw new Bad('Password must be at least 8 characters');
      const name = text(u.name, 100, true);
      if (u.id) {
        const id = intId(u.id);
        if (id === me.id && u.role !== 'admin') throw new Bad('You cannot remove your own admin access');
        await db`update users set name = ${name}, role = ${u.role}, salary = ${salary} where id = ${id}`;
        if (password) await db`update users set password_hash = ${hashPassword(password)} where id = ${id}`;
        return;
      }
      const email = text(u.email, 200, true).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Bad('Enter a valid email');
      if (!password) throw new Bad('Set a password for the new login');
      const rows = await db`insert into users (email, name, password_hash, role, salary) values (${email}, ${name}, ${hashPassword(password)}, ${u.role}, ${salary})
                            on conflict (email) do nothing returning id`;
      if (!rows.length) throw new Bad('A login with that email already exists');
      return;
    }
  }
  throw new Bad('Unknown action');
}

export default async function handler(req, res) {
  const me = await requireUser(req, res);
  if (!me) return;
  const db = sql();
  try {
    if (req.method === 'GET' && req.query.invoice) {
      const [inv] = await db`select id, user_id as "userId", kind, number, to_char(invoice_date, 'YYYY-MM-DD') as date, items,
                                    total::float8 as total, status, note, employer, employee
                             from invoices where id = ${intId(req.query.invoice)} and (${me.role !== 'employee'} or user_id = ${me.id})`;
      if (!inv) return res.status(404).json({ error: 'Invoice not found' });
      return res.status(200).json(inv);
    }
    if (req.method === 'GET' && req.query.view === 'register') {
      if (me.role === 'employee') return res.status(403).json({ error: 'You do not have access to this' });
      const from = date(req.query.from);
      const to = date(req.query.to);
      return res.status(200).json({ rows: await registerRows(db, from, to) });
    }
    if (req.method === 'POST') {
      await act(db, me, req.body);
      // Re-read the user so profile/salary changes show up straight away.
      Object.assign(me, (await db`select profile from users where id = ${me.id}`)[0]);
    } else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.status(200).json(await readState(db, me));
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}
