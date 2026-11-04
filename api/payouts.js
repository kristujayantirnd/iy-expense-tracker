import { sql, requireUser, hashPassword, verifyPassword, registerRows, sheetToken, driveToken } from './_lib.js';
import { copyToDrive, deleteFromDrive, SCRIPT_URL } from './_pdf.js';
import { clearInvoiceBills, driveFileId } from './_bills.js';

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
// Each reimbursement row needs a bill: { upload: <bill id>, name } or { drive: <file id>, name }.
const billRef = (b) => {
  const name = text(b?.name, 200);
  if (b?.upload) return { upload: intId(b.upload), name };
  if (b?.drive) {
    try {
      return { drive: driveFileId(b.drive), name };
    } catch (e) {
      throw new Bad(e.message);
    }
  }
  throw new Bad('Attach a bill (PDF upload or Google Drive link) to every row');
};
const pick = (obj, fields, max) => Object.fromEntries(fields.map((f) => [f, text(obj?.[f], max)]));

const getEmployer = async (db) => {
  const rows = await db`select value from settings where key = 'employer'`;
  return rows.length ? JSON.parse(rows[0].value) : {};
};

const getDrive = async (db) => {
  const rows = await db`select key, value from settings where key in ('driveFolder', 'driveScript')`;
  const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { folder: cfg.driveFolder || '', script: cfg.driveScript || '' };
};

// List queries leave out signatures (large); the invoice PDF reads the full copy.
async function readState(db, me) {
  const all = me.role !== 'employee';
  const [invoices, categories, users, revisions] = await db.transaction([
    db`select i.id, i.user_id as "userId", i.kind, i.number, to_char(i.invoice_date, 'YYYY-MM-DD') as date, i.items,
              i.total::float8 as total, i.status, i.note, i.payment_status as "paymentStatus", i.drive_url as "driveUrl", i.drive_error as "driveError", i.direct, u.email, case when i.direct then 'Direct Expense' else coalesce(nullif(u.name, ''), nullif(u.profile->>'name', ''), u.email) end as name
       from invoices i join users u on u.id = i.user_id
       where ${all} or i.user_id = ${me.id}
       order by i.invoice_date desc, i.id desc`,
    db`select id, name from categories order by name`,
    all
      ? db`select u.id, u.email, u.role, u.salary::float8 as "latestSalary", coalesce(nullif(u.name, ''), u.profile->>'name', '') as name, u.active,
              coalesce(cur.new_salary, u.salary)::float8 as salary, nxt.new_salary::float8 as "nextSalary", to_char(nxt.effective_date, 'YYYY-MM-DD') as "nextFrom"
           from users u
           left join lateral (select new_salary from salary_revisions r where r.user_id = u.id
                                and (r.old_salary is null or r.effective_date <= (now() at time zone 'Asia/Kolkata')::date)
                              order by case when r.old_salary is null then date '0001-01-01' else r.effective_date end desc, r.id desc limit 1) cur on true
           left join lateral (select new_salary, effective_date from salary_revisions r where r.user_id = u.id and r.old_salary is not null
                                and r.effective_date > (now() at time zone 'Asia/Kolkata')::date
                              order by r.effective_date, r.id limit 1) nxt on true
           order by u.active desc, u.role, 5, u.email`
      : db`select 1 where false`,
    db`select r.id, r.user_id as "userId", r.old_salary::float8 as "oldSalary", r.new_salary::float8 as "newSalary",
              to_char(r.effective_date, 'YYYY-MM-DD') as "effectiveDate", r.note, to_char(r.created_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as "recordedOn",
              coalesce(nullif(c.name, ''), c.email, '') as "recordedBy"
       from salary_revisions r left join users c on c.id = r.created_by
       where ${me.role !== 'employee'} or r.user_id = ${me.id}
       order by r.user_id, r.effective_date, r.id`,
  ]);
  const { signature, ...profile } = me.profile || {};
  const [ptLink] = await db`select 1 from pt_owner_links where user_id = ${me.id}`;
  return {
    me: { id: me.id, email: me.email, name: me.name, role: me.role, salary: me.salary, profile, hasSignature: Boolean(signature), ptLinked: Boolean(ptLink) },
    employer: await getEmployer(db),
    invoices,
    categories,
    users: all ? users : [],
    revisions,
    sheetToken: me.role === 'admin' ? sheetToken() : undefined,
    expenses: me.role === 'admin' ? await db`select id, title, amount::float8 as amount, category_id as "categoryId", type from expenses order by title` : undefined,
    drive: me.role === 'admin' ? { ...(await getDrive(db)), secret: driveToken() } : undefined,
  };
}

const LOCKED = ['approved', 'cancelled'];

// Optional direct-expense category (tracker categories) on each reimbursement row.
// Returns the rows with categoryId checked (null when not picked).
async function withCategories(db, items, picks) {
  const ids = new Set((await db`select id from categories`).map((c) => c.id));
  return items.map((it, n) => {
    const v = picks[n];
    if (v === undefined || v === null || v === '') return { ...it, categoryId: null };
    if (!ids.has(String(v))) throw new Bad(`The expense category on row ${n + 1} no longer exists`);
    return { ...it, categoryId: String(v) };
  });
}

// India date (YYYY-MM-DD): reimbursement rows are stamped with the day they were entered.
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
// Rows keep the date they were first entered; a missing, bad or future date becomes today.
const rowDate = (v) => (DATE.test(String(v || '')) && !Number.isNaN(Date.parse(v)) && v <= todayIST() ? v : todayIST());

// Salary in effect on a date: the latest revision effective on or before it. A starting salary (no previous
// amount) counts from the very beginning, so a backdated hike still wins from its own date. No history: defined salary.
async function salaryOn(db, userId, day, fallback) {
  const [r] = await db`select new_salary::float8 as salary from salary_revisions
                       where user_id = ${userId} and (old_salary is null or effective_date <= ${day})
                       order by case when old_salary is null then date '0001-01-01' else effective_date end desc, id desc limit 1`;
  return r ? r.salary : fallback;
}

async function saveInvoice(db, me, body) {
  const admin = me.role === 'admin';
  let kind = body.kind;
  let ownerId = me.id;
  let existing = null;
  if (body.id) {
    [existing] = await db`select user_id, kind, status, items, direct from invoices where id = ${intId(body.id)}`;
    // Owners edit their own; the admin may also edit salary invoices (they can raise them for anyone).
    if (!existing || (existing.user_id !== me.id && !(admin && existing.kind === 'salary'))) throw new Bad('Invoice not found');
    if (LOCKED.includes(existing.status)) throw new Bad(`This invoice is ${existing.status} and can no longer be edited`);
    kind = existing.kind;
    ownerId = existing.user_id;
  } else if (body.userId && Number(body.userId) !== me.id) {
    if (!admin || !['salary', 'reimbursement'].includes(kind)) throw new Bad('Only the admin can raise invoices for someone else');
    ownerId = intId(body.userId);
  }
  // Direct expense: a reimbursement for the company's direct expenses, raised by the admin, no employee.
  const direct = existing ? Boolean(existing.direct) : body.direct === true;
  if (direct && (!admin || kind !== 'reimbursement')) throw new Bad('Only the admin can raise direct-expense invoices');
  if (direct) ownerId = me.id;
  const [owner] = await db`select id, email, salary::float8 as salary, profile, active from users where id = ${ownerId}`;
  if (!owner) throw new Bad('Employee not found');
  if (!owner.active) throw new Bad('That login is inactive');
  const self = owner.id === me.id;
  if (!direct && !owner.profile?.name) throw new Bad(self ? 'Fill in your profile before raising an invoice' : 'That employee has not filled in their profile yet');

  // Reimbursements collect on one open (pending or rejected) invoice per employee until it is approved.
  let incoming = body.items;
  if (kind === 'reimbursement' && !existing) {
    const [open] = direct
      ? await db`select id, user_id, kind, status, items, direct from invoices where direct and kind = 'reimbursement' and status in ('pending', 'rejected')`
      : await db`select id, user_id, kind, status, items, direct from invoices
                 where user_id = ${owner.id} and kind = 'reimbursement' and status in ('pending', 'rejected') and not direct`;
    if (open) {
      existing = open;
      body = { ...body, id: open.id };
      incoming = [...open.items, ...(Array.isArray(body.items) ? body.items : [])];
    }
  }

  let items;
  let invoiceDate;
  if (kind === 'salary') {
    invoiceDate = date(body.date);
    // Amount = defined salary, unless the admin sets another; an admin-set amount survives the employee's own edits.
    const defined = await salaryOn(db, owner.id, invoiceDate, owner.salary);
    let amount = defined;
    let adjusted = false;
    if (admin && body.amount !== undefined && body.amount !== '') {
      amount = money(body.amount);
      adjusted = amount !== defined;
    } else if (existing?.items?.[0]?.adjusted) {
      amount = existing.items[0].amount;
      adjusted = true;
    }
    if (!(amount > 0)) throw new Bad(self ? 'Your salary has not been set by the admin yet' : "Set that employee's salary in Logins & Salaries first");
    const [y, m] = invoiceDate.split('-');
    items = [{ particulars: `Salary for ${MONTHS[Number(m) - 1]} ${y}`, amount, ...(adjusted ? { adjusted: true } : {}) }];
  } else if (kind === 'reimbursement') {
    if (!Array.isArray(incoming) || !incoming.length) throw new Bad('Add at least one line item');
    if (incoming.length > 50) throw new Bad('Too many line items on this invoice (50 at most)');
    items = incoming.map((it) => ({ date: rowDate(it?.date), particulars: text(it?.particulars, 300, true), amount: money(it?.amount), bill: billRef(it?.bill),
      ...(it?.expenseId ? { expenseId: text(it.expenseId, 64) } : {}) }));
    // direct-expense rows point at an Expense Tracker direct expense
    const expIds = [...new Set(items.filter((it) => it.expenseId).map((it) => it.expenseId))];
    if (expIds.length && (await db`select id from expenses where id = any(${expIds})`).length !== expIds.length) throw new Bad('A direct expense on this invoice no longer exists');
    items = await withCategories(db, items, incoming.map((it) => it?.categoryId));
    invoiceDate = items.reduce((d, it) => (it.date > d ? it.date : d), items[0].date); // latest row
    // Uploaded bills must be the employee's own and still in storage.
    const ids = items.filter((it) => it.bill.upload).map((it) => it.bill.upload);
    // the employee's own uploads, or ones the admin uploaded while raising it for them
    const found = ids.length ? await db`select id from bills where id = any(${ids}) and user_id = any(${[owner.id, me.id]}) and deleted_at is null` : [];
    if (found.length !== new Set(ids).size) throw new Bad('A bill upload was not found, please attach it again');
  } else throw new Bad('Unknown invoice type');

  const total = Math.round(items.reduce((s, it) => s + it.amount * 100, 0)) / 100;
  const employer = JSON.stringify(await getEmployer(db));
  const employee = JSON.stringify(direct ? { direct: true } : { ...owner.profile, email: owner.email });
  const itemsJson = JSON.stringify(items);
  try {
    if (existing) {
      // Editing (pending or rejected) sends it back for approval.
      const rows = await db`update invoices set invoice_date = ${invoiceDate}, items = ${itemsJson}, total = ${total},
                              employer = ${employer}, employee = ${employee}, status = 'pending', note = ''
                            where id = ${intId(body.id)} and status not in ('approved', 'cancelled') returning id`;
      if (!rows.length) throw new Bad('This invoice is approved and can no longer be edited');
    } else {
      // Salary: max + 1 (not a sequence) so failed submissions never leave gaps; unique (kind, number) catches races.
      // Reimbursement: numbered only when approved.
      await db`insert into invoices (user_id, kind, number, invoice_date, items, total, employer, employee, direct)
               select ${owner.id}, ${kind}, case when ${kind} = 'salary' then coalesce(max(number), 0) + 1 end, ${invoiceDate}, ${itemsJson}, ${total}, ${employer}, ${employee}, ${direct}
               from invoices where kind = ${kind}`;
    }
  } catch (e) {
    if (e.code === '23505' && e.constraint === 'one_salary_invoice_per_month') throw new Bad(self ? 'You already have a salary invoice for that month' : 'That employee already has a salary invoice for that month');
    if (e.code === '23505') throw new Bad('Something was submitted at the same moment, please submit again');
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
      const id = intId(body.id);
      // The admin may set or change each row's expense category while reviewing a reimbursement.
      if (Array.isArray(body.categories)) {
        const [inv] = await db`select items from invoices where id = ${id} and kind = 'reimbursement' and status = 'pending'`;
        if (inv) {
          const items = await withCategories(db, inv.items, body.categories);
          await db`update invoices set items = ${JSON.stringify(items)} where id = ${id} and status = 'pending'`;
        }
      }
      // A reimbursement gets its number on approval (next in sequence, so no gaps).
      const rows = await db`update invoices set status = ${body.status}, note = ${text(body.note, 500)}, decided_by = ${me.id}, decided_at = now(),
                              number = case when number is null and ${body.status} = 'approved'
                                            then (select coalesce(max(number), 0) + 1 from invoices where kind = 'reimbursement') else number end
                            where id = ${id} and status = 'pending' returning id`;
      if (!rows.length) throw new Bad('Only pending invoices can be approved or rejected');
      if (body.status === 'approved') await copyToDrive(db, rows[0].id);
      return;
    }
    case 'cancel': {
      if (!admin) throw new Bad('Only the admin can cancel invoices');
      const reason = text(body.reason, 500, true);
      // decided_by / decided_at keep the original approval.
      const rows = await db`update invoices set status = 'cancelled', note = ${'Cancelled: ' + reason}
                            where id = ${intId(body.id)} and status = 'approved' returning id`;
      if (!rows.length) throw new Bad('Only approved invoices can be cancelled');
      // Free the uploaded bill files and remove the Drive copy.
      const freed = await clearInvoiceBills(db, rows[0].id);
      const drive = await deleteFromDrive(db, rows[0].id);
      return { notice: { freed, driveDeleted: drive.deleted, driveError: drive.error } };
    }
    case 'driveDelete': {
      if (!admin) throw new Bad('Only the admin can delete Drive copies');
      const [inv] = await db`select status from invoices where id = ${intId(body.id)}`;
      if (inv?.status !== 'cancelled') throw new Bad('Only cancelled invoices have their Drive copy deleted');
      const drive = await deleteFromDrive(db, intId(body.id));
      return { notice: { driveDeleted: drive.deleted, driveError: drive.error } };
    }
    case 'driveCopy': {
      if (!admin) throw new Bad('Only the admin can copy invoices to Drive');
      const [inv] = await db`select status from invoices where id = ${intId(body.id)}`;
      if (inv?.status !== 'approved') throw new Bad('Only approved invoices are copied to Drive');
      return copyToDrive(db, intId(body.id));
    }
    case 'payment': {
      if (!admin) throw new Bad('Only the admin can update payment status');
      if (!['', 'submitted', 'paid'].includes(body.paymentStatus)) throw new Bad('Unknown payment status');
      const rows = await db`update invoices set payment_status = ${body.paymentStatus} where id = ${intId(body.id)} and status = 'approved' returning id`;
      if (!rows.length) throw new Bad('Only approved invoices can be marked Submitted or Payment Completed');
      return;
    }
    case 'drive': {
      if (!admin) throw new Bad('Only the admin can change Drive settings');
      const folder = String(body.folder || '').trim();
      const m = folder.match(/\/folders\/([\w-]{10,})/) || folder.match(/^([\w-]{10,})$/);
      if (folder && !m) throw new Bad('Paste the Google Drive folder link (it contains /folders/)');
      const script = String(body.script || '').trim();
      if (script && !SCRIPT_URL.test(script)) throw new Bad('The script link must look like https://script.google.com/macros/s/…/exec');
      return db.transaction([
        db`insert into settings (key, value) values ('driveFolder', ${m ? m[1] : ''}) on conflict (key) do update set value = excluded.value`,
        db`insert into settings (key, value) values ('driveScript', ${script}) on conflict (key) do update set value = excluded.value`,
      ]);
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
      const active = u.active !== false;
      const revNote = text(u.revisionNote, 300);
      if (u.id) {
        const id = intId(u.id);
        if (id === me.id && u.role !== 'admin') throw new Bad('You cannot remove your own admin access');
        if (id === me.id && !active) throw new Bad('You cannot deactivate your own login');
        const [cur] = await db`select salary::float8 as salary from users where id = ${id}`;
        if (!cur) throw new Bad('Login not found');
        // A salary change is recorded as a revision with its effective date.
        if (cur.salary !== salary) {
          const effective = date(u.effectiveDate);
          await db`insert into salary_revisions (user_id, old_salary, new_salary, effective_date, note, created_by)
                   values (${id}, ${cur.salary > 0 ? cur.salary : null}, ${salary}, ${effective}, ${revNote}, ${me.id})`;
        }
        await db`update users set name = ${name}, role = ${u.role}, salary = ${salary}, active = ${active} where id = ${id}`;
        if (password) await db`update users set password_hash = ${hashPassword(password)} where id = ${id}`;
        return;
      }
      const email = text(u.email, 200, true).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Bad('Enter a valid email');
      if (!password) throw new Bad('Set a password for the new login');
      const rows = await db`insert into users (email, name, password_hash, role, salary, active) values (${email}, ${name}, ${hashPassword(password)}, ${u.role}, ${salary}, ${active})
                            on conflict (email) do nothing returning id`;
      if (!rows.length) throw new Bad('A login with that email already exists');
      if (salary > 0) {
        await db`insert into salary_revisions (user_id, old_salary, new_salary, effective_date, note, created_by)
                 values (${rows[0].id}, null, ${salary}, ${u.effectiveDate ? date(u.effectiveDate) : todayIST()}, ${revNote || 'Starting salary'}, ${me.id})`;
      }
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
    if (req.method === 'GET' && req.query.view === 'register') {
      if (me.role === 'employee') return res.status(403).json({ error: 'You do not have access to this' });
      const from = date(req.query.from);
      const to = date(req.query.to);
      const userId = req.query.userId ? intId(req.query.userId) : null;
      const kind = req.query.kind || null;
      if (kind && !['salary', 'reimbursement'].includes(kind)) throw new Bad('Unknown invoice type');
      return res.status(200).json({ rows: await registerRows(db, from, to, { userId, kind }) });
    }
    if (req.method === 'POST') {
      const out = await act(db, me, req.body);
      // Re-read the user so profile/salary changes show up straight away.
      Object.assign(me, (await db`select profile from users where id = ${me.id}`)[0]);
      return res.status(200).json({ ...(await readState(db, me)), notice: out?.notice });
    } else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.status(200).json(await readState(db, me));
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}
