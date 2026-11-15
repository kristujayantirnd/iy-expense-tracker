// Receivables · Products & Services, Rate Cards and Client Engagement Plans.
// Admin and Finance Admin change them; Management can look.
// GET                         -> { products, rateCards, plans, clients, canEdit, admin }
// GET ?view=revenue           -> { invoices, allocations } for the revenue dashboard (plus the masters)
// POST {action, …}            -> product | deleteProduct | rateCard | deleteRateCard | apply | plan | freeze | unfreeze | deletePlan | reorderPlans | generateInvoices
//
// Product items carry a pricing model, a mandatory flag and prerequisites (other item ids). A rate card copies
// those attributes per item (they may be changed there) and adds a unit price. A client plan copies a rate card,
// then takes units per item: actual = unit price x units; signed up starts as the actual and may be changed.
// Once frozen, the plan's signed-up total is fixed: later edits must still add up to it.
import { sql, requireUser, isFinanceAdmin } from './_lib.js';
import { isDb, pushExtract, pushRequest, typeSentence, DUE_DAYS } from './client-invoices.js';

class Bad extends Error {}
export const PRICING = { per_head: 'Per Head', per_head_month: 'Per Head-Monthly', per_batch: 'Per Batch', per_hour: 'Per Hour', per_day: 'Per Day', per_month: 'Per Month', fixed: 'Fixed' };

const text = (v, max = 200, required = false, what = 'name') => {
  const s = String(v ?? '').trim();
  if (required && !s) throw new Bad(`Add the ${what}`);
  if (s.length > max) throw new Bad(`The ${what} is too long`);
  return s;
};
const intId = (v, what = 'record') => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Bad(`Pick a ${what}`);
  return n;
};
const num = (v, max, what) => {
  const n = v === '' || v == null ? 0 : Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Bad(`${what} must be a number from 0 to ${max.toLocaleString('en-IN')}`);
  return n;
};
const pricing = (v) => {
  if (!PRICING[v]) throw new Bad('Pick a pricing model');
  return v;
};
const r2 = (n) => Math.round(n * 100) / 100;
// Per Head-Monthly rows also multiply by their months.
export const actualOf = (it) => r2(Number(it.unitPrice) * Number(it.units) * (it.pricingModel === 'per_head_month' ? Number(it.months ?? 1) : 1));
export const signedOf = (it) => (it.signedUp == null ? actualOf(it) : r2(Number(it.signedUp)));

async function readAll(db) {
  const [products, items, cards, cardItems, plans, planItems, clients, employees, schedule] = await db.transaction([
    db`select id, name, description from ps_products order by lower(name)`,
    db`select id, product_id as "productId", name, pricing_model as "pricingModel", mandatory, prerequisites, notes, employee_ids as "employeeIds", employee_split as "employeeSplit" from ps_items order by product_id, sort, id`,
    db`select id, name, description, to_char(updated_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "updatedOn" from rate_cards order by lower(name)`,
    db`select rate_card_id as "rateCardId", item_id as "itemId", unit_price::float8 as "unitPrice", pricing_model as "pricingModel", mandatory, prerequisites
       from rate_card_items order by rate_card_id, sort, id`,
    db`select p.id, p.client_id as "clientId", c.name as client, p.name, p.rate_card_id as "rateCardId", p.notes,
              p.frozen_total::float8 as "frozenTotal", to_char(p.frozen_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "frozenOn",
              coalesce(nullif(f.name, ''), f.email) as "frozenBy", to_char(p.updated_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "updatedOn"
       from client_plans p join clients c on c.id = p.client_id left join users f on f.id = p.frozen_by
       order by p.sort, p.created_at desc`,
    db`select plan_id as "planId", item_id as "itemId", pricing_model as "pricingModel", mandatory, prerequisites,
              unit_price::float8 as "unitPrice", units::float8 as units, months::float8 as months, signed_up::float8 as "signedUp", notes,
              employee_ids as "employeeIds", employee_split as "employeeSplit"
       from client_plan_items order by plan_id, sort, id`,
    db`select id, name from clients order by lower(name)`,
    db`select id, coalesce(nullif(name, ''), nullif(profile->>'name', ''), email) as name from users where active order by 2`,
    db`select s.plan_id as "planId", s.seq, s.amount::float8 as amount, to_char(s.invoice_date, 'YYYY-MM-DD') as "invoiceDate", s.invoice_id as "invoiceId",
              s.particulars, to_char(coalesce(r.due_date, s.due_date), 'YYYY-MM-DD') as "dueDate", s.po_number as "poNumber",
              r.status, r.invoice_number as "invoiceNumber", to_char(r.invoice_date, 'YYYY-MM-DD') as "currentDate"
       from plan_invoices s left join receivable_invoices r on r.id = s.invoice_id order by s.plan_id, s.seq`,
  ]);
  return {
    products: products.map((p) => ({ ...p, items: items.filter((i) => i.productId === p.id) })),
    rateCards: cards.map((c) => ({ ...c, items: cardItems.filter((i) => i.rateCardId === c.id) })),
    plans: plans.map((p) => ({ ...p, items: planItems.filter((i) => i.planId === p.id),
      // a generated row shows its invoice's current date (it can be moved in Manage Invoices until approved)
      schedule: schedule.filter((x) => x.planId === p.id).map((x) => ({ ...x, invoiceDate: x.currentDate || x.invoiceDate })) })),
    clients,
    employees,
  };
}

// Optional employees (logins) mapped to a list item.
function employeesOf(v, staff) {
  const ids = [...new Set((Array.isArray(v) ? v : []).map(Number))];
  if (ids.some((x) => !staff.has(x))) throw new Bad('An employee picked for a list item no longer exists, please reload');
  return ids;
}

// A plan row's own employees and split (null / null = follow the list item in Products & Services).
function planTeam(it, staff) {
  if (!Array.isArray(it.employeeIds)) return { employeeIds: null, employeeSplit: null };
  const employeeIds = employeesOf(it.employeeIds, staff);
  return { employeeIds, employeeSplit: splitOf(it.employeeSplit, employeeIds, 'A plan row') };
}

// Employee-wise revenue split of a list item: percents for its mapped employees adding up to 100, or {} (equal shares).
function splitOf(v, employeeIds, name) {
  if (!v || typeof v !== 'object' || employeeIds.length < 2) return {};
  const out = {};
  for (const id of employeeIds) {
    const pct = Math.round(Number(v[id] ?? 0) * 100) / 100;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Bad(`"${name}": each employee's share must be 0 to 100%`);
    out[id] = pct;
  }
  const total = Object.values(out).reduce((s, x) => s + x, 0);
  if (!Object.values(v).some((x) => Number(x) > 0)) return {};
  if (Math.abs(total - 100) > 0.01) throw new Bad(`"${name}": the employee split adds up to ${Math.round(total * 100) / 100}%, it must be 100%`);
  return out;
}

// The item ids that exist, so prerequisites and rows can only point at real items.
const itemIds = async (db) => new Set((await db`select id from ps_items`).map((r) => r.id));

/* ---------- Products & Services ---------- */

// items: [{ key, id?, name, pricingModel, mandatory, prerequisites: [keys] }]; key = the id, or 'n1', 'n2'… for new rows.
async function saveProduct(db, body) {
  const p = body.product || {};
  const name = text(p.name, 150, true, 'product or service name');
  const description = text(p.description, 1000, false, 'description');
  const rows = Array.isArray(p.items) ? p.items : [];
  if (rows.length > 200) throw new Bad('Up to 200 list items per product or service');
  const known = await itemIds(db);
  const staff = new Set((await db`select id from users`).map((u) => u.id));
  const keys = new Set();
  const items = rows.map((it, n) => {
    const key = String(it?.key ?? '');
    if (!key || keys.has(key)) throw new Bad('Something went wrong with the list, please reload');
    keys.add(key);
    return { key, id: it.id ? intId(it.id) : null, name: text(it.name, 200, true, `name of list item ${n + 1}`), pricingModel: pricing(it.pricingModel),
      mandatory: it.mandatory === true, prerequisites: [...new Set((Array.isArray(it.prerequisites) ? it.prerequisites : []).map(String))].filter((k) => k !== key),
      notes: text(it.notes, 1000, false, `notes of list item ${n + 1}`), employeeIds: employeesOf(it.employeeIds, staff) };
  });
  for (const [n, it] of items.entries()) it.employeeSplit = splitOf(rows[n].employeeSplit, it.employeeIds, it.name);
  const lower = items.map((i) => i.name.toLowerCase());
  const dup = lower.find((n, i) => lower.indexOf(n) !== i);
  if (dup) throw new Bad(`"${items[lower.indexOf(dup)].name}" is in the list twice`);
  for (const it of items) {
    for (const k of it.prerequisites) if (!keys.has(k) && !known.has(Number(k))) throw new Bad(`A prerequisite of "${it.name}" no longer exists`);
  }

  // Every check before the first write, so a refused save changes nothing.
  let id = p.id ? intId(p.id) : null;
  const existing = id ? await db`select id from ps_items where product_id = ${id}` : [];
  const keep = new Set(items.filter((i) => i.id).map((i) => i.id));
  if (items.some((i) => i.id && !existing.some((e) => e.id === i.id))) throw new Bad('A list item belongs to another product or service, please reload');
  const gone = existing.map((e) => e.id).filter((x) => !keep.has(x));
  if (gone.length) {
    const used = await db`select distinct i.name from ps_items i where i.id = any(${gone})
                            and (exists (select 1 from rate_card_items r where r.item_id = i.id) or exists (select 1 from client_plan_items c where c.item_id = i.id))`;
    if (used.length) throw new Bad(`${used.map((u) => `"${u.name}"`).join(', ')} is used in a rate card or client plan, so it can't be removed`);
  }
  try {
    if (id) {
      const done = await db`update ps_products set name = ${name}, description = ${description} where id = ${id} returning id`;
      if (!done.length) throw new Bad('That product or service no longer exists');
    } else {
      [{ id }] = await db`insert into ps_products (name, description) values (${name}, ${description}) returning id`;
    }
  } catch (e) {
    if (e.code === '23505') throw new Bad('A product or service with that name already exists');
    throw e;
  }
  if (gone.length) {
    // nothing may keep pointing at a removed item
    await db.transaction([
      db`update ps_items set prerequisites = (select coalesce(array_agg(x), '{}') from unnest(prerequisites) x where x <> all(${gone}::int[])) where prerequisites && ${gone}::int[]`,
      db`update rate_card_items set prerequisites = (select coalesce(array_agg(x), '{}') from unnest(prerequisites) x where x <> all(${gone}::int[])) where prerequisites && ${gone}::int[]`,
      db`update client_plan_items set prerequisites = (select coalesce(array_agg(x), '{}') from unnest(prerequisites) x where x <> all(${gone}::int[])) where prerequisites && ${gone}::int[]`,
      db`delete from ps_items where id = any(${gone})`,
    ]);
  }
  // New rows first (they need ids), then every row with its prerequisites mapped from keys to ids.
  const idOf = new Map(items.filter((i) => i.id).map((i) => [i.key, i.id]));
  for (const it of items.filter((i) => !i.id)) {
    const [row] = await db`insert into ps_items (product_id, name, pricing_model) values (${id}, ${it.name}, ${it.pricingModel}) returning id`;
    idOf.set(it.key, row.id);
  }
  const toId = (k) => idOf.get(k) ?? Number(k);
  await db.transaction(items.map((it, n) => db`
    update ps_items set name = ${it.name}, pricing_model = ${it.pricingModel}, mandatory = ${it.mandatory},
                        prerequisites = ${it.prerequisites.map(toId)}::int[], notes = ${it.notes}, employee_ids = ${it.employeeIds}::int[],
                        employee_split = ${JSON.stringify(it.employeeSplit)}::jsonb, sort = ${n}
    where id = ${idOf.get(it.key)}`));
  return { notice: 'Product / service saved', id };
}

async function deleteProduct(db, body) {
  const id = intId(body.id);
  const [used] = await db`select count(*)::int n from ps_items i where i.product_id = ${id}
                            and (exists (select 1 from rate_card_items r where r.item_id = i.id) or exists (select 1 from client_plan_items c where c.item_id = i.id))`;
  if (used.n) throw new Bad('Its list items are used in a rate card or client plan, so it can\'t be deleted');
  const ids = (await db`select id from ps_items where product_id = ${id}`).map((r) => r.id);
  await db.transaction([
    db`update ps_items set prerequisites = (select coalesce(array_agg(x), '{}') from unnest(prerequisites) x where x <> all(${ids}::int[])) where prerequisites && ${ids}::int[]`,
    db`delete from ps_products where id = ${id}`,
  ]);
  return { notice: 'Product / service deleted' };
}

/* ---------- Rate cards ---------- */

// items: [{ itemId, unitPrice, pricingModel, mandatory, prerequisites: [itemIds] }] (the whole card, replaced)
async function saveRateCard(db, body) {
  const c = body.rateCard || {};
  const name = text(c.name, 150, true, 'rate card name');
  const description = text(c.description, 1000, false, 'description');
  const known = await itemIds(db);
  const rows = Array.isArray(c.items) ? c.items : [];
  if (rows.length > 500) throw new Bad('Up to 500 items per rate card');
  const seen = new Set();
  const items = rows.map((it) => {
    const itemId = intId(it?.itemId, 'list item');
    if (!known.has(itemId)) throw new Bad('A list item on this rate card no longer exists, please reload');
    if (seen.has(itemId)) throw new Bad('A list item is on the rate card twice');
    seen.add(itemId);
    const prerequisites = [...new Set((Array.isArray(it.prerequisites) ? it.prerequisites : []).map(Number))].filter((x) => x !== itemId);
    if (prerequisites.some((x) => !known.has(x))) throw new Bad('A prerequisite no longer exists, please reload');
    return { itemId, unitPrice: num(it.unitPrice, 1e10, 'Charge'), pricingModel: pricing(it.pricingModel), mandatory: it.mandatory === true, prerequisites };
  });
  let id = c.id ? intId(c.id) : null;
  try {
    if (id) {
      const done = await db`update rate_cards set name = ${name}, description = ${description}, updated_at = now() where id = ${id} returning id`;
      if (!done.length) throw new Bad('That rate card no longer exists');
    } else {
      [{ id }] = await db`insert into rate_cards (name, description) values (${name}, ${description}) returning id`;
    }
  } catch (e) {
    if (e.code === '23505') throw new Bad('A rate card with that name already exists');
    throw e;
  }
  await db.transaction([
    db`delete from rate_card_items where rate_card_id = ${id}`,
    ...items.map((it, n) => db`insert into rate_card_items (rate_card_id, item_id, unit_price, pricing_model, mandatory, prerequisites, sort)
                               values (${id}, ${it.itemId}, ${it.unitPrice}, ${it.pricingModel}, ${it.mandatory}, ${it.prerequisites}::int[], ${n})`),
  ]);
  return { notice: 'Rate card saved', id };
}

/* ---------- Client engagement plans ---------- */

async function applyRateCard(db, me, body) {
  const clientId = intId(body.clientId, 'client');
  const rateCardId = intId(body.rateCardId, 'rate card');
  const [client] = await db`select name from clients where id = ${clientId}`;
  if (!client) throw new Bad('That client no longer exists');
  const [card] = await db`select name from rate_cards where id = ${rateCardId}`;
  if (!card) throw new Bad('That rate card no longer exists');
  const name = text(body.name, 150, false, 'plan name') || card.name;
  // a new plan goes to the top of the list
  const [{ id }] = await db`insert into client_plans (client_id, name, rate_card_id, updated_by, sort)
                            select ${clientId}, ${name}, ${rateCardId}, ${me.id}, coalesce(min(sort), 0) - 1 from client_plans returning id`;
  await db`insert into client_plan_items (plan_id, item_id, pricing_model, mandatory, prerequisites, unit_price, units, months, sort)
           select ${id}, item_id, pricing_model, mandatory, prerequisites, unit_price, 1, case when pricing_model = 'per_head_month' then 1 end, sort
           from rate_card_items where rate_card_id = ${rateCardId}`;
  return { notice: `${card.name} copied to ${client.name}. Now set the units for each item.`, id };
}

// Rule checks for a plan's rows: prerequisites present, and the mandatory items of every product in the plan.
// An item counts as taken only with a quantity: units above 0 (and months, for Per Head-Monthly); Fixed always counts.
export const taken = (it) => it.pricingModel === 'fixed' || (Number(it.units) > 0 && (it.pricingModel !== 'per_head_month' || Number(it.months ?? 1) > 0));

async function planProblems(db, rateCardId, items) {
  const ids = new Set(items.filter(taken).map((i) => i.itemId));
  const listed = new Set(items.map((i) => i.itemId));
  const all = await db`select i.id, i.name, i.product_id as "productId", i.mandatory, p.name as product from ps_items i join ps_products p on p.id = i.product_id`;
  const byId = new Map(all.map((i) => [i.id, i]));
  const card = rateCardId ? await db`select item_id, mandatory from rate_card_items where rate_card_id = ${rateCardId}` : [];
  const cardMandatory = new Map(card.map((r) => [r.item_id, r.mandatory]));
  const cardProducts = new Set(card.map((r) => byId.get(r.item_id)?.productId));
  const problems = [];
  // A taken item needs each prerequisite taken too (in the plan with units above 0).
  for (const it of items.filter(taken)) {
    const missing = it.prerequisites.filter((p) => !ids.has(p) && byId.has(p));
    if (missing.length) {
      problems.push(`"${byId.get(it.itemId).name}" needs ${missing.map((m) => `"${byId.get(m).name}"${listed.has(m) ? ' (its units are 0)' : ''}`).join(', ')} first`);
    }
  }
  // A product on the rate card follows the rate card's mandatory flags; one added from the master follows the master's.
  for (const productId of new Set(items.map((i) => byId.get(i.itemId).productId))) {
    for (const x of all.filter((i) => i.productId === productId && !ids.has(i.id))) {
      const required = cardProducts.has(productId) ? cardMandatory.get(x.id) === true : x.mandatory;
      if (required) problems.push(`"${x.name}" is mandatory for ${x.product}${listed.has(x.id) ? ' (its units are 0)' : ''}`);
    }
  }
  return problems;
}

// items: [{ itemId, unitPrice, units, signedUp (null = same as actual) }] (the whole plan, replaced).
// Attributes come from the plan's own copy, else the rate card's, else the master.
async function savePlan(db, me, body) {
  const p = body.plan || {};
  const id = intId(p.id, 'plan');
  const [plan] = await db`select rate_card_id, frozen_total::float8 as "frozenTotal" from client_plans where id = ${id}`;
  if (!plan) throw new Bad('That plan no longer exists');
  const rows = Array.isArray(p.items) ? p.items : [];
  if (!rows.length) throw new Bad('Add at least one item to the plan');
  if (rows.length > 500) throw new Bad('Up to 500 items per plan');
  const [own, card, master] = await db.transaction([
    db`select item_id, pricing_model, mandatory, prerequisites from client_plan_items where plan_id = ${id}`,
    db`select item_id, pricing_model, mandatory, prerequisites from rate_card_items where rate_card_id = ${plan.rate_card_id ?? 0}`,
    db`select id as item_id, pricing_model, mandatory, prerequisites from ps_items`,
  ]);
  const masterIds = new Set(master.map((m) => m.item_id));
  const attrs = (itemId) => own.find((r) => r.item_id === itemId) || card.find((r) => r.item_id === itemId) || master.find((r) => r.item_id === itemId);
  const seen = new Set();
  const staff = new Set((await db`select id from users`).map((u) => u.id));
  const items = rows.map((it) => {
    const itemId = intId(it?.itemId, 'list item');
    const known = attrs(itemId);
    if (!known) throw new Bad('A list item in this plan no longer exists, please reload');
    // The tags shown on screen win (a row removed and added back picks up the rate card's current tags);
    // anything not sent keeps the plan's own copy, else the rate card's, else the master's.
    const a = {
      pricing_model: it.pricingModel ? pricing(it.pricingModel) : known.pricing_model,
      mandatory: typeof it.mandatory === 'boolean' ? it.mandatory : known.mandatory,
      prerequisites: Array.isArray(it.prerequisites) ? [...new Set(it.prerequisites.map(Number))].filter((x) => x !== itemId && masterIds.has(x)) : known.prerequisites,
    };
    if (seen.has(itemId)) throw new Bad('A list item is in the plan twice');
    seen.add(itemId);
    const units = a.pricing_model === 'fixed' ? 1 : num(it.units, 1e6, 'Units');
    const months = a.pricing_model === 'per_head_month' ? (it.months === '' || it.months == null ? 1 : num(it.months, 1e4, 'Months')) : null;
    const signedUp = it.signedUp === '' || it.signedUp == null ? null : num(it.signedUp, 1e10, 'Signed up');
    return { itemId, pricingModel: a.pricing_model, mandatory: a.mandatory, prerequisites: a.prerequisites, unitPrice: num(it.unitPrice, 1e10, 'Unit price'), units, months,
      signedUp, notes: text(it.notes, 1000, false, 'row notes'), ...planTeam(it, staff) };
  });
  const problems = await planProblems(db, plan.rate_card_id, items);
  if (problems.length) throw new Bad(`Can't save yet: ${problems.join('; ')}.`);
  if (plan.frozenTotal != null) {
    const total = r2(items.reduce((s, it) => s + signedOf(it), 0));
    if (Math.round(total * 100) !== Math.round(plan.frozenTotal * 100)) {
      const diff = r2(plan.frozenTotal - total);
      throw new Bad(`This plan is frozen at ${rupees(plan.frozenTotal)}. The signed-up column adds up to ${rupees(total)}, ${rupees(Math.abs(diff))} ${diff > 0 ? 'short' : 'over'}. Adjust the signed-up amounts so they add up to the frozen total.`);
    }
  }
  const schedule = Array.isArray(p.schedule) ? await cleanSchedule(db, id, p.schedule) : null;
  await db.transaction([
    ...(schedule ? [db`delete from plan_invoices where plan_id = ${id} and invoice_id is null`,
      ...schedule.rows.map((x, n) => db`insert into plan_invoices (plan_id, seq, amount, invoice_date, due_date, particulars, po_number)
                                        values (${id}, ${schedule.start + n}, ${x.amount}, ${x.invoiceDate}, ${x.dueDate}, ${x.particulars}, ${x.poNumber})`)] : []),
    db`update client_plans set name = ${text(p.name, 150, true, 'plan name')}, notes = ${text(p.notes, 2000, false, 'notes')}, updated_by = ${me.id}, updated_at = now() where id = ${id}`,
    db`delete from client_plan_items where plan_id = ${id}`,
    ...items.map((it, n) => db`insert into client_plan_items (plan_id, item_id, pricing_model, mandatory, prerequisites, unit_price, units, months, signed_up, notes, employee_ids, employee_split, sort)
                               values (${id}, ${it.itemId}, ${it.pricingModel}, ${it.mandatory}, ${it.prerequisites}::int[], ${it.unitPrice}, ${it.units}, ${it.months}, ${it.signedUp}, ${it.notes},
                                       ${it.employeeIds}::int[], ${it.employeeSplit ? JSON.stringify(it.employeeSplit) : null}::jsonb, ${n})`),
  ]);
  return { notice: plan.frozenTotal != null ? 'Saved. The signed-up total still matches the frozen total.' : 'Plan saved', id };
}

// The invoice schedule's rows not generated yet: [{ amount, invoiceDate, dueDate, particulars, poNumber }] (generated rows stay as they are).
async function cleanSchedule(db, planId, rows) {
  if (rows.length > 60) throw new Bad('Up to 60 invoices per plan');
  const [{ max }] = await db`select coalesce(max(seq), 0)::int as max from plan_invoices where plan_id = ${planId} and invoice_id is not null`;
  return { start: max + 1, rows: rows.filter((x) => !x.invoiceId).map((x, n) => {
    const amount = num(x.amount, 1e10, `Invoice ${n + 1} amount`);
    if (!(amount > 0)) throw new Bad(`Invoice ${n + 1}: the amount must be above 0`);
    const d = String(x.invoiceDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) throw new Bad(`Invoice ${n + 1}: pick a date`);
    const due = String(x.dueDate || '');
    if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due)))) throw new Bad(`Invoice ${n + 1}: pick a valid due date`);
    if (due && due < d) throw new Bad(`Invoice ${n + 1}: the due date is before the invoice date`);
    return { amount, invoiceDate: d, dueDate: due || null, particulars: text(x.particulars, 1000, false, `particulars of invoice ${n + 1}`), poNumber: text(x.poNumber, 300, false, `PO number of invoice ${n + 1}`) };
  }) };
}

// Turns a frozen plan's schedule rows into Finance Team requests + NEW_ENTRY invoices (rows already generated are
// skipped), each accounted to the plan's items in proportion to their signed-up amounts.
async function generateInvoices(db, me, body) {
  const id = intId(body.id, 'plan');
  if (!(await isDb(db))) throw new Bad('Receivables must be moved to the database first (Receivables → Automator Settings)');
  const [plan] = await db`select p.name, p.frozen_total::float8 as "frozenTotal", c.name as client from client_plans p join clients c on c.id = p.client_id where p.id = ${id}`;
  if (!plan) throw new Bad('That plan no longer exists');
  if (plan.frozenTotal == null) throw new Bad('Freeze the plan first, so the signed-up total the invoices add up to is fixed');
  const rows = await db`select id, seq, amount::float8 as amount, to_char(invoice_date, 'YYYY-MM-DD') as d, to_char(due_date, 'YYYY-MM-DD') as due,
                               particulars, po_number, invoice_id from plan_invoices where plan_id = ${id} order by seq`;
  if (!rows.length) throw new Bad('Set the number of invoices and their dates, then save the plan');
  const total = r2(rows.reduce((s, x) => s + x.amount, 0));
  if (Math.round(total * 100) !== Math.round(plan.frozenTotal * 100)) {
    throw new Bad(`The invoices add up to ${rupees(total)} but the plan is frozen at ${rupees(plan.frozenTotal)}. Adjust the invoice amounts and save.`);
  }
  const todo = rows.filter((x) => !x.invoice_id);
  if (!todo.length) throw new Bad('All the invoices of this plan have been generated already');
  const items = (await db`select item_id as "itemId", pricing_model as "pricingModel", unit_price::float8 as "unitPrice", units::float8 as units,
                                 months::float8 as months, signed_up::float8 as "signedUp" from client_plan_items where plan_id = ${id} order by sort`)
    .map((it) => ({ itemId: it.itemId, signed: signedOf(it) })).filter((it) => it.signed > 0);
  const base = r2(items.reduce((s, it) => s + it.signed, 0));
  if (!(base > 0)) throw new Bad('The plan has no signed-up amounts to account the invoices to');
  let sheetErrors = 0;
  for (const x of todo) {
    const k = rows.indexOf(x) + 1;
    const [q] = await db`insert into invoice_requests (invoice_type, client, invoice_date, description, po_number, amount)
                         values ('Service', ${plan.client}, ${x.d}, ${x.particulars || `${plan.name} - Invoice ${k}`}, ${x.po_number || 'N/A'}, ${x.amount}) returning id`;
    const [inv] = await db`insert into receivable_invoices (client, invoice_date, amount, due_date, invoice_type, status, request_id, updated_by)
                           values (${plan.client}, ${x.d}, ${x.amount}, coalesce(${x.due}::date, ${x.d}::date + ${DUE_DAYS}::int), ${typeSentence('Service')}, 'NEW_ENTRY', ${q.id}, ${me.id}) returning id`;
    // proportional shares; the rounding paise go to the largest item so the shares add up to the invoice
    const shares = items.map((it) => ({ itemId: it.itemId, amount: r2((x.amount * it.signed) / base) }));
    const gap = r2(x.amount - shares.reduce((s, a) => s + a.amount, 0));
    if (gap) shares.reduce((a, b) => (b.amount > a.amount ? b : a)).amount = r2(shares.reduce((a, b) => (b.amount > a.amount ? b : a)).amount + gap);
    await db.transaction([
      ...shares.map((a) => db`insert into invoice_allocations (invoice_id, plan_id, item_id, amount) values (${inv.id}, ${id}, ${a.itemId}, ${a.amount})`),
      db`update plan_invoices set invoice_id = ${inv.id} where id = ${x.id}`,
    ]);
    if ((await pushRequest(db, q.id)).error) sheetErrors++;
    if (await pushExtract(db, inv.id)) sheetErrors++;
  }
  return { id, notice: `${todo.length} invoice${todo.length > 1 ? 's' : ''} generated for ${plan.client}: Finance Team requests and new entries in Manage Invoices.`
    + (sheetErrors ? ` ${sheetErrors} sheet cop${sheetErrors > 1 ? 'ies' : 'y'} failed; use Retry sheet sync in Manage Invoices.` : '') };
}

// Revenue dashboard: every invoice (dashboard status and amount without GST) and how plan invoices split across items.
async function revenue(db) {
  const [invoices, allocations] = await db.transaction([
    db`select id, client, invoice_number as "invoiceNumber", to_char(invoice_date, 'YYYY-MM-DD') as date, status, amount::float8 as amount from receivable_invoices`,
    db`select invoice_id as "invoiceId", item_id as "itemId", plan_id as "planId", amount::float8 as amount from invoice_allocations`,
  ]);
  return { invoices, allocations };
}

const rupees = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function freeze(db, me, body) {
  const id = intId(body.id, 'plan');
  const items = (await db`select pricing_model as "pricingModel", unit_price::float8 as "unitPrice", units::float8 as units, months::float8 as months, signed_up::float8 as "signedUp"
                          from client_plan_items where plan_id = ${id}`);
  if (!items.length) throw new Bad('Save the plan with at least one item before freezing it');
  const total = r2(items.reduce((s, it) => s + signedOf(it), 0));
  if (!(total > 0)) throw new Bad('The signed-up total is ₹0. Set the units and charges before freezing.');
  const done = await db`update client_plans set frozen_total = ${total}, frozen_at = now(), frozen_by = ${me.id} where id = ${id} and frozen_total is null returning id`;
  if (!done.length) throw new Bad('This plan is already frozen');
  return { notice: `Frozen at ${rupees(total)}. Later changes must keep the signed-up total at this amount.`, id };
}

async function act(db, me, body) {
  switch (body?.action) {
    case 'product': return saveProduct(db, body);
    case 'deleteProduct': return deleteProduct(db, body);
    case 'rateCard': return saveRateCard(db, body);
    case 'deleteRateCard': {
      await db`delete from rate_cards where id = ${intId(body.id)}`; // client plans keep their copies
      return { notice: 'Rate card deleted. Client plans made from it are unchanged.' };
    }
    case 'apply': return applyRateCard(db, me, body);
    case 'plan': return savePlan(db, me, body);
    case 'freeze': return freeze(db, me, body);
    case 'generateInvoices': return generateInvoices(db, me, body);
    case 'unfreeze': {
      if (me.role !== 'admin') throw new Bad('Only the admin can unfreeze a plan');
      await db`update client_plans set frozen_total = null, frozen_at = null, frozen_by = null where id = ${intId(body.id)}`;
      return { notice: 'Plan unfrozen. The signed-up total can change again.', id: Number(body.id) };
    }
    case 'reorderPlans': {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map((x) => intId(x, 'plan'));
      if (!ids.length || new Set(ids).size !== ids.length) throw new Bad('Something went wrong with the order, please reload');
      await db.transaction(ids.map((id, n) => db`update client_plans set sort = ${n} where id = ${id}`));
      return { notice: 'Order saved' };
    }
    case 'deletePlan': {
      const id = intId(body.id, 'plan');
      const [p] = await db`select frozen_total from client_plans where id = ${id}`;
      if (p?.frozen_total != null && me.role !== 'admin') throw new Bad('Frozen plans can only be deleted by the admin');
      const [g] = await db`select count(*)::int as n from plan_invoices where plan_id = ${id} and invoice_id is not null`;
      if (g.n) throw new Bad(`This plan has generated ${g.n} invoice(s), so it is kept for the revenue figures`);
      await db`delete from client_plans where id = ${id}`;
      return { notice: 'Plan deleted' };
    }
  }
  throw new Bad('Unknown action');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const me = await requireUser(req, res);
  if (!me) return;
  const canEdit = isFinanceAdmin(me);
  if (!canEdit && me.role !== 'management') return res.status(403).json({ error: 'You do not have access to this' });
  const db = sql();
  try {
    let out = {};
    if (req.method === 'GET' && req.query.view === 'revenue') out = await revenue(db);
    if (req.method === 'POST') {
      if (!canEdit) return res.status(403).json({ error: 'Only Admin and Finance Admin can change these' });
      out = await act(db, me, req.body);
    } else if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    return res.status(200).json({ ...(await readAll(db)), ...out, pricing: PRICING, canEdit, admin: me.role === 'admin' });
  } catch (e) {
    if (e instanceof Bad) return res.status(400).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
