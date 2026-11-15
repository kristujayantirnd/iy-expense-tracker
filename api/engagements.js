// Receivables · Products & Services, Rate Cards and Client Engagement Plans.
// Admin and Finance Admin change them; Management can look.
// GET                         -> { products, rateCards, plans, clients, canEdit, admin }
// POST {action, …}            -> product | deleteProduct | rateCard | deleteRateCard | apply | plan | freeze | unfreeze | deletePlan | reorderPlans
//
// Product items carry a pricing model, a mandatory flag and prerequisites (other item ids). A rate card copies
// those attributes per item (they may be changed there) and adds a unit price. A client plan copies a rate card,
// then takes units per item: actual = unit price x units; signed up starts as the actual and may be changed.
// Once frozen, the plan's signed-up total is fixed: later edits must still add up to it.
import { sql, requireUser, isFinanceAdmin } from './_lib.js';

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
  const [products, items, cards, cardItems, plans, planItems, clients, employees] = await db.transaction([
    db`select id, name, description from ps_products order by lower(name)`,
    db`select id, product_id as "productId", name, pricing_model as "pricingModel", mandatory, prerequisites, notes, employee_ids as "employeeIds" from ps_items order by product_id, sort, id`,
    db`select id, name, description, to_char(updated_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "updatedOn" from rate_cards order by lower(name)`,
    db`select rate_card_id as "rateCardId", item_id as "itemId", unit_price::float8 as "unitPrice", pricing_model as "pricingModel", mandatory, prerequisites
       from rate_card_items order by rate_card_id, sort, id`,
    db`select p.id, p.client_id as "clientId", c.name as client, p.name, p.rate_card_id as "rateCardId", p.notes,
              p.frozen_total::float8 as "frozenTotal", to_char(p.frozen_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "frozenOn",
              coalesce(nullif(f.name, ''), f.email) as "frozenBy", to_char(p.updated_at at time zone 'Asia/Kolkata', 'DD/MM/YYYY') as "updatedOn"
       from client_plans p join clients c on c.id = p.client_id left join users f on f.id = p.frozen_by
       order by p.sort, p.created_at desc`,
    db`select plan_id as "planId", item_id as "itemId", pricing_model as "pricingModel", mandatory, prerequisites,
              unit_price::float8 as "unitPrice", units::float8 as units, months::float8 as months, signed_up::float8 as "signedUp", notes
       from client_plan_items order by plan_id, sort, id`,
    db`select id, name from clients order by lower(name)`,
    db`select id, coalesce(nullif(name, ''), nullif(profile->>'name', ''), email) as name from users where active order by 2`,
  ]);
  return {
    products: products.map((p) => ({ ...p, items: items.filter((i) => i.productId === p.id) })),
    rateCards: cards.map((c) => ({ ...c, items: cardItems.filter((i) => i.rateCardId === c.id) })),
    plans: plans.map((p) => ({ ...p, items: planItems.filter((i) => i.planId === p.id) })),
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
                        prerequisites = ${it.prerequisites.map(toId)}::int[], notes = ${it.notes}, employee_ids = ${it.employeeIds}::int[], sort = ${n}
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
  const attrs = (itemId) => own.find((r) => r.item_id === itemId) || card.find((r) => r.item_id === itemId) || master.find((r) => r.item_id === itemId);
  const seen = new Set();
  const items = rows.map((it) => {
    const itemId = intId(it?.itemId, 'list item');
    const a = attrs(itemId);
    if (!a) throw new Bad('A list item in this plan no longer exists, please reload');
    if (seen.has(itemId)) throw new Bad('A list item is in the plan twice');
    seen.add(itemId);
    const units = a.pricing_model === 'fixed' ? 1 : num(it.units, 1e6, 'Units');
    const months = a.pricing_model === 'per_head_month' ? (it.months === '' || it.months == null ? 1 : num(it.months, 1e4, 'Months')) : null;
    const signedUp = it.signedUp === '' || it.signedUp == null ? null : num(it.signedUp, 1e10, 'Signed up');
    return { itemId, pricingModel: a.pricing_model, mandatory: a.mandatory, prerequisites: a.prerequisites, unitPrice: num(it.unitPrice, 1e10, 'Unit price'), units, months,
      signedUp, notes: text(it.notes, 1000, false, 'row notes') };
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
  await db.transaction([
    db`update client_plans set name = ${text(p.name, 150, true, 'plan name')}, notes = ${text(p.notes, 2000, false, 'notes')}, updated_by = ${me.id}, updated_at = now() where id = ${id}`,
    db`delete from client_plan_items where plan_id = ${id}`,
    ...items.map((it, n) => db`insert into client_plan_items (plan_id, item_id, pricing_model, mandatory, prerequisites, unit_price, units, months, signed_up, notes, sort)
                               values (${id}, ${it.itemId}, ${it.pricingModel}, ${it.mandatory}, ${it.prerequisites}::int[], ${it.unitPrice}, ${it.units}, ${it.months}, ${it.signedUp}, ${it.notes}, ${n})`),
  ]);
  return { notice: plan.frozenTotal != null ? 'Saved. The signed-up total still matches the frozen total.' : 'Plan saved', id };
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
