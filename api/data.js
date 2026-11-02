import { sql, requireUser } from './_lib.js';

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
  const [settings, categories, employees, expenses] = await db.transaction([
    db`select key, value from settings`,
    db`select id, name, budget::float8 as budget, color from categories order by created_at, id`,
    db`select id, name, role, base_salary::float8 as "baseSalary", allocations from employees order by created_at, id`,
    db`select id, title, category_id as "categoryId", type, amount::float8 as amount, notes from expenses order by created_at, id`,
  ]);
  const currency = settings.find((s) => s.key === 'currency')?.value || 'INR';
  return { currency, categories, employees, expenses };
}

async function upsert(db, type, item) {
  if (type === 'currency') {
    if (!CURRENCIES.includes(item)) throw new Bad('Unknown currency');
    return db`insert into settings (key, value) values ('currency', ${item})
              on conflict (key) do update set value = excluded.value`;
  }
  if (!item || typeof item !== 'object') throw new Bad('Missing item');

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
    return db`insert into employees (id, name, role, base_salary, allocations)
              values (${id(item.id)}, ${text(item.name, 100, true)}, ${text(item.role, 100)}, ${money(item.baseSalary)}, ${JSON.stringify(allocations)})
              on conflict (id) do update set name = excluded.name, role = excluded.role,
                base_salary = excluded.base_salary, allocations = excluded.allocations`;
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
  if (type === 'employee') return db`delete from employees where id = ${rowId}`;
  if (type === 'expense') return db`delete from expenses where id = ${rowId}`;
  throw new Bad('Unknown type');
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const db = sql();
  try {
    if (req.method === 'POST') await upsert(db, req.body?.type, req.body?.item);
    else if (req.method === 'DELETE') await remove(db, req.query.type, req.query.id);
    else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    res.status(200).json({ ...(await readState(db)), user: user.email });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
}
