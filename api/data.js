import { randomBytes } from 'node:crypto';
import { sql, requireUser, ptAccess } from './_lib.js';
import { PT_URL } from './project-tracker.js';

// Strategic Priorities: named shortcuts to Project Tracker projects, kept in settings as a JSON array
// [{id, name, url, token}]. token = the project's share token from its view-only link
// (<tracker>/project-board.html?t=<32 hex>); the board's data is fetched through this server.
const PRIORITIES = 'strategicPriorities';
const SHARE_TOKEN = /[?&]t=([0-9a-f]{32})(?:&|#|$)/i;
const parseList = (value) => { try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const readPriorities = async (db) => parseList((await db`select value from settings where key = ${PRIORITIES}`)[0]?.value);
const publicPriority = ({ id, name, url }) => ({ id, name, url }); // the share token stays on the server

const ID = /^[\w-]{1,64}$/;
const COLOR = /^#[0-9a-f]{6}$/i;
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP'];
const EXPENSE_TYPES = ['Monthly Recurring', 'One-Time Expense', 'Annual Software'];

class Bad extends Error {}
const text = (v, max = 200, required = false) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new Bad('Required field is empty');
  if (s.length > max) throw new Bad('Text is too long');
  return s;
};
const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new Bad('Amount must be a positive number');
  return n;
};
const id = (v) => {
  if (!ID.test(String(v))) throw new Bad('Invalid id');
  return String(v);
};

async function readState(db) {
  const [settings, categories, employees, expenses, revisions] = await db.transaction([
    db`select key, value from settings`,
    db`select id, name, budget::float8 as budget, color from categories order by created_at, id`,
    // Directory = every login (all are employees; Payouts > Logins & Salaries); the employees row 'u<userId>' adds designation + split.
    db`select 'u' || u.id as id, coalesce(nullif(u.name, ''), nullif(u.profile->>'name', ''), u.email) as name, coalesce(e.role, '') as role,
              -- salary in effect today (same rule as payouts salaryOn); falls back to the defined salary
              coalesce((select r.new_salary from salary_revisions r where r.user_id = u.id
                          and (r.old_salary is null or r.effective_date <= (now() at time zone 'Asia/Kolkata')::date)
                        order by case when r.old_salary is null then date '0001-01-01' else r.effective_date end desc, r.id desc limit 1),
                       u.salary)::float8 as "baseSalary", coalesce(e.allocations, '{}') as allocations
       from users u left join employees e on e.id = 'u' || u.id
       order by 2`,
    db`select id, title, category_id as "categoryId", type, amount::float8 as amount, notes from expenses order by created_at, id`,
    // salary revisions, keyed like the directory ('u<userId>'), for the Executive Report's earlier-salaries button
    db`select 'u' || user_id as "employeeId", id, old_salary::float8 as "oldSalary", new_salary::float8 as "newSalary",
              to_char(effective_date, 'YYYY-MM-DD') as "effectiveDate", note
       from salary_revisions order by user_id, effective_date, id`,
  ]);
  const currency = settings.find((s) => s.key === 'currency')?.value || 'INR';
  const priorities = parseList(settings.find((s) => s.key === PRIORITIES)?.value).map(publicPriority);
  return { currency, categories, employees, expenses, revisions, priorities };
}

// The project's board from the Project Tracker's view-only API (pending + completed stages).
async function fetchBoard(token) {
  let res;
  try {
    res = await fetch(`${PT_URL}/api/project-board?t=${token}`, { cache: 'no-store' });
  } catch {
    throw new Bad('Could not reach the Project Tracker');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Bad(data.error || 'This project link is not valid or has been reset');
  if (!res.ok) throw new Bad(data.error || `The Project Tracker answered ${res.status}`);
  return data;
}

async function priorityBoard(db, priorityId) {
  const p = (await readPriorities(db)).find((x) => x.id === priorityId);
  if (!p) throw new Bad('That strategic priority no longer exists');
  return fetchBoard(p.token);
}

// Categorised reimbursement rows entered between from and to (by row date), from invoices that are
// pending or approved (incl. Submitted / Payment Completed). Rejected and cancelled are left out.
async function reimbursementRows(db, from, to) {
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if (!DAY.test(String(from)) || !DAY.test(String(to))) throw new Bad('Pick a valid date range');
  return db`select i.id as "invoiceId", i.number, i.status, i.payment_status as "paymentStatus",
                   case when i.direct then 'Direct Expense' else coalesce(nullif(u.name, ''), nullif(u.profile->>'name', ''), u.email) end as employee,
                   it->>'date' as date, it->>'particulars' as particulars, (it->>'amount')::float8 as amount, it->>'categoryId' as "categoryId"
            from invoices i join users u on u.id = i.user_id, jsonb_array_elements(i.items) it
            where i.kind = 'reimbursement' and i.status in ('pending', 'approved')
              and coalesce(it->>'categoryId', '') <> '' and it->>'date' between ${String(from)} and ${String(to)}
            order by it->>'date', i.id`;
}

async function upsert(db, type, item) {
  if (type === 'currency') {
    if (!CURRENCIES.includes(item)) throw new Bad('Unknown currency');
    return db`insert into settings (key, value) values ('currency', ${item})
              on conflict (key) do update set value = excluded.value`;
  }
  if (!item || typeof item !== 'object') throw new Bad('Missing item');

  if (type === 'priority') {
    const name = text(item.name, 80, true);
    const url = text(item.url, 500, true);
    const token = url.match(SHARE_TOKEN)?.[1]?.toLowerCase();
    if (!token) throw new Bad("Paste the project's view link (it ends with ?t= and a 32-character code)");
    await fetchBoard(token); // fails early if the link is wrong or was reset
    const entry = JSON.stringify([{ id: 'sp' + randomBytes(6).toString('hex'), name, url, token }]);
    return db`insert into settings (key, value) values (${PRIORITIES}, ${entry})
              on conflict (key) do update set value = (settings.value::jsonb || excluded.value::jsonb)::text`;
  }

  if (type === 'category') {
    const color = String(item.color || '#3b82f6');
    if (!COLOR.test(color)) throw new Bad('Invalid color');
    return db`insert into categories (id, name, budget, color)
              values (${id(item.id)}, ${text(item.name, 100, true)}, ${money(item.budget || 0)}, ${color})
              on conflict (id) do update set name = excluded.name, budget = excluded.budget, color = excluded.color`;
  }

  if (type === 'employee') {
    const allocations = {};
    for (const [catId, pct] of Object.entries(item.allocations || {})) {
      const n = Number(pct);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Bad('Allocation must be between 0 and 100');
      if (n > 0) allocations[id(catId)] = n;
    }
    // Name and salary live on the login; only designation and split are saved here.
    const userId = Number(String(item.id).replace(/^u/, ''));
    const [u] = Number.isInteger(userId) ? await db`select id from users where id = ${userId}` : [];
    if (!u) throw new Bad('Add employees in Payouts > Logins & Salaries');
    return db`insert into employees (id, name, role, base_salary, allocations)
              values (${'u' + userId}, '', ${text(item.role, 100)}, 0, ${JSON.stringify(allocations)})
              on conflict (id) do update set role = excluded.role, allocations = excluded.allocations`;
  }

  if (type === 'expense') {
    if (!EXPENSE_TYPES.includes(item.type)) throw new Bad('Unknown expense type');
    const categoryId = item.categoryId ? id(item.categoryId) : null;
    return db`insert into expenses (id, title, category_id, type, amount, notes)
              values (${id(item.id)}, ${text(item.title, 200, true)}, ${categoryId}, ${item.type}, ${money(item.amount)}, ${text(item.notes, 500)})
              on conflict (id) do update set title = excluded.title, category_id = excluded.category_id,
                type = excluded.type, amount = excluded.amount, notes = excluded.notes`;
  }
  throw new Bad('Unknown type');
}

async function remove(db, type, rowId) {
  rowId = id(rowId);
  if (type === 'category') {
    // Expenses keep their row (category set to null by the foreign key); employee splits drop the category.
    return db.transaction([
      db`update employees set allocations = allocations - ${rowId}`,
      db`delete from categories where id = ${rowId}`,
    ]);
  }
  if (type === 'priority') {
    return db`update settings set value = (select coalesce(jsonb_agg(e), '[]'::jsonb) from jsonb_array_elements(value::jsonb) e
                                           where e->>'id' <> ${rowId})::text
              where key = ${PRIORITIES}`;
  }
  if (type === 'employee') throw new Bad('Remove employees in Payouts > Logins & Salaries');
  if (type === 'expense') return db`delete from expenses where id = ${rowId}`;
  throw new Bad('Unknown type');
}

export default async function handler(req, res) {
  // Employees use the payouts page only; management can look but not change.
  const user = await requireUser(req, res, req.method === 'GET' ? ['admin', 'management'] : ['admin']);
  if (!user) return;
  const db = sql();
  try {
    if (req.method === 'GET' && req.query.view === 'reimbursements') {
      return res.status(200).json({ rows: await reimbursementRows(db, req.query.from, req.query.to) });
    }
    if (req.method === 'GET' && req.query.view === 'priorities') {
      // the Strategic Priorities page needs only the list, not the whole dashboard
      const list = await readPriorities(db);
      const [ptLink] = await db`select 1 from pt_owner_links where user_id = ${user.id} limit 1`;
      return res.status(200).json({ priorities: list.map(publicPriority), user: user.email, role: user.role, ptLinked: ptAccess(ptLink, user.extra_roles) });
    }
    if (req.method === 'GET' && req.query.view === 'priority') {
      return res.status(200).json(await priorityBoard(db, id(req.query.id)));
    }
    if (req.method === 'POST') await upsert(db, req.body?.type, req.body?.item);
    else if (req.method === 'DELETE') await remove(db, req.query.type, req.query.id);
    else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const [ptLink] = await db`select 1 from pt_owner_links where user_id = ${user.id} limit 1`;
    res.status(200).json({ ...(await readState(db)), user: user.email, role: user.role, ptLinked: ptAccess(ptLink, user.extra_roles) });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}
