// Receivables · Products & Services, Rate Cards and Engagement Plans (talks to /api/engagements).
// Admin and Finance Admin edit; Management sees the same screens read-only.
// Uses $id, toast and modal from invoice-automator.js, and esc / formatINR from the page.
const E = { data: null, loading: null, product: null, card: null, plan: null, newKey: 0 };
const UNIT_LABEL = { per_head: 'Head count', per_batch: 'Batches', per_hour: 'Hours', per_day: 'Days', per_month: 'Months', fixed: 'Fixed' };
const engR2 = (n) => Math.round(n * 100) / 100;
const engMoney = (n) => formatINR(Number(n) || 0);
const engPct = (n) => (n === null || !Number.isFinite(n) ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const engItem = (id) => E.itemMap.get(id);
const engCanEdit = () => E.data && E.data.canEdit;

function startEngagements() {
  document.querySelectorAll('.eng-only').forEach((el) => el.classList.remove('d-none'));
  ['products-tab', 'ratecards-tab', 'plans-tab'].forEach((id) => $id(id).addEventListener('shown.bs.tab', () => engLoad()));
}

// Loads (once, or again after a save) everything the three tabs need.
async function engLoad(force = false) {
  if (E.data && !force) return engRenderAll();
  if (E.loading) return E.loading;
  E.loading = (async () => {
    try {
      const res = await fetch('/api/engagements', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load products and rate cards');
      engSetData(data);
    } catch (e) {
      ['psList'].forEach((id) => ($id(id).innerHTML = `<div class="text-danger py-3">${esc(e.message)}</div>`));
    } finally {
      E.loading = null;
    }
  })();
  return E.loading;
}

function engSetData(data) {
  E.data = data;
  E.itemMap = new Map();
  for (const p of data.products) for (const it of p.items) E.itemMap.set(it.id, { ...it, product: p.name });
  document.querySelectorAll('.eng-edit').forEach((el) => el.classList.toggle('d-none', !data.canEdit));
  engRenderAll();
}

function engRenderAll() {
  engRenderProducts();
  if (!E.card) engRenderCards();
  if (!E.plan) engRenderPlans();
}

async function engPost(body, done) {
  try {
    const res = await fetch('/api/engagements', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    engSetData(data);
    toast(data.notice || done);
    return data;
  } catch (e) {
    toast(e.message, false);
    return null;
  }
}

/* ---------- multi-select (checkbox dropdown) ---------- */

// options: [{ value, label, group }]; selected: values. onchange names a global function called with (key, values).
// Ticking a box updates the label in place (no re-render), so the dropdown stays open for more picks.
function engMulti(key, options, selected, onchange, disabled = false) {
  let group = null;
  const items = options.map((o) => {
    const head = o.group && o.group !== group ? `<li><h6 class="dropdown-header">${esc((group = o.group))}</h6></li>` : '';
    return `${head}<li><label class="dropdown-item small d-flex gap-2 align-items-center" style="white-space:normal">
      <input type="checkbox" class="form-check-input m-0" value="${esc(o.value)}" data-label="${esc(o.label)}" ${selected.includes(o.value) ? 'checked' : ''}
        onchange="engMultiPick(this, '${onchange}', '${esc(key)}')">${esc(o.label)}</label></li>`;
  }).join('');
  return `<div class="dropdown">
    <button type="button" class="btn btn-light border btn-sm text-start text-truncate w-100" style="max-width:16rem" data-bs-toggle="dropdown" data-bs-auto-close="outside"
      data-bs-popper-config='{"strategy":"fixed"}' ${disabled ? 'disabled' : ''}>${engMultiLabel(options.filter((o) => selected.includes(o.value)).map((o) => o.label))}</button>
    <ul class="dropdown-menu shadow-sm" style="max-height:18rem;overflow:auto;min-width:16rem">${items || '<li class="dropdown-item small text-muted">No other items</li>'}</ul></div>`;
}
const engMultiLabel = (labels) => (labels.length ? `<span class="badge bg-secondary me-1">${labels.length}</span>${esc(labels.join(', '))}` : 'None');
function engMultiPick(box, fn, key) {
  const ul = box.closest('ul');
  const picked = [...ul.querySelectorAll('input:checked')];
  ul.previousElementSibling.innerHTML = engMultiLabel(picked.map((x) => x.dataset.label));
  window[fn](key, picked.map((x) => x.value));
}

const engPricingSelect = (value, onchange, disabled = false, label = 'Pricing model') => `<select class="form-select form-select-sm" aria-label="${esc(label)}" onchange="${onchange}" ${disabled ? 'disabled' : ''}>
  ${Object.entries(E.data.pricing).map(([k, v]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${v}</option>`).join('')}</select>`;

/* ---------- Products & Services ---------- */

function engRenderProducts() {
  if (!E.data) return;
  const words = $id('psSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const list = E.data.products.filter((p) => { const hay = [p.name, p.description, ...p.items.map((i) => i.name)].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); });
  if (!list.length) {
    $id('psList').innerHTML = `<div class="text-muted text-center py-4">${E.data.products.length ? 'Nothing matches the search.' : 'No products or services yet.' + (engCanEdit() ? ' Add the first one.' : '')}</div>`;
    return;
  }
  $id('psList').innerHTML = list.map((p) => `
    <div class="border rounded-3 mb-3">
      <div class="d-flex justify-content-between align-items-start gap-2 p-3 pb-2">
        <div><div class="fw-bold">${esc(p.name)}</div>${p.description ? `<div class="small text-muted">${esc(p.description)}</div>` : ''}</div>
        ${engCanEdit() ? `<button class="btn btn-light border btn-sm" onclick="engOpenProduct(${p.id})"><i class="fa-solid fa-pen"></i> Edit</button>` : ''}
      </div>
      <div class="table-responsive"><table class="table table-sm align-middle small mb-0">
        <thead class="bg-light"><tr><th class="ps-3">List item</th><th>Pricing model</th><th>Mandatory</th><th>Prerequisites</th></tr></thead>
        <tbody>${p.items.map((it) => `<tr><td class="ps-3">${esc(it.name)}</td><td>${E.data.pricing[it.pricingModel]}</td>
          <td>${it.mandatory ? '<span class="badge badge-soft badge-soft-pending">Y</span>' : '<span class="text-muted">N</span>'}</td>
          <td>${it.prerequisites.map((x) => esc(engItem(x)?.name || '?')).join(', ') || '<span class="text-muted">–</span>'}</td></tr>`).join('')
          || '<tr><td colspan="4" class="ps-3 text-muted">No list items yet.</td></tr>'}</tbody></table></div>
    </div>`).join('');
}

function engOpenProduct(id) {
  const p = id ? E.data.products.find((x) => x.id === id) : null;
  E.product = { id: p ? p.id : null, items: (p ? p.items : []).map((it) => ({ key: String(it.id), id: it.id, name: it.name, pricingModel: it.pricingModel, mandatory: it.mandatory, prerequisites: it.prerequisites.map(String) })) };
  if (!p) engAddPsItem(false);
  $id('psTitle').textContent = p ? `Edit ${p.name}` : 'Add product / service';
  $id('psName').value = p ? p.name : '';
  $id('psDesc').value = p ? p.description : '';
  $id('psDelete').classList.toggle('d-none', !p);
  engRenderPsItems();
  modal('psModal').show();
}

function engAddPsItem(render = true) {
  E.product.items.push({ key: `n${++E.newKey}`, id: null, name: '', pricingModel: 'per_head', mandatory: false, prerequisites: [] });
  if (render) { engRenderPsItems(); $id('psItems').querySelector('tbody tr:last-child input')?.focus(); }
}

// Prerequisite choices: this product's other rows (saved or new), then the other products' items.
function engPsPrereqOptions(key) {
  const own = E.product.items.filter((i) => i.key !== key && i.name.trim()).map((i) => ({ value: i.key, label: i.name, group: 'This product / service' }));
  const others = [];
  for (const p of E.data.products) if (p.id !== E.product.id) for (const it of p.items) others.push({ value: String(it.id), label: it.name, group: p.name });
  return [...own, ...others];
}

function engRenderPsItems() {
  const rows = E.product.items;
  $id('psItems').innerHTML = `<thead class="bg-light"><tr><th style="min-width:14rem">List item</th><th style="width:11rem">Pricing model</th><th style="width:6rem">Mandatory</th><th style="min-width:14rem">Prerequisites</th><th style="width:3rem"></th></tr></thead><tbody>`
    + rows.map((it, n) => `<tr>
      <td><input class="form-control form-control-sm" value="${esc(it.name)}" maxlength="200" required aria-label="List item ${n + 1} name" oninput="E.product.items[${n}].name = this.value" onchange="engRenderPsItems()"></td>
      <td>${engPricingSelect(it.pricingModel, `E.product.items[${n}].pricingModel = this.value`, false, `Pricing model, item ${n + 1}`)}</td>
      <td><select class="form-select form-select-sm" aria-label="Mandatory, item ${n + 1}" onchange="E.product.items[${n}].mandatory = this.value === 'Y'">
        <option ${it.mandatory ? '' : 'selected'}>N</option><option ${it.mandatory ? 'selected' : ''}>Y</option></select></td>
      <td>${engMulti(it.key, engPsPrereqOptions(it.key), it.prerequisites, 'engPsPrereq')}</td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" onclick="engRemovePsItem(${n})" aria-label="Remove list item ${n + 1}"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join('')
    + (rows.length ? '' : '<tr><td colspan="5" class="text-muted">No list items. Add one.</td></tr>') + '</tbody>';
}

function engPsPrereq(key, values) { E.product.items.find((i) => i.key === key).prerequisites = values; }

function engRemovePsItem(n) {
  const [gone] = E.product.items.splice(n, 1);
  for (const it of E.product.items) it.prerequisites = it.prerequisites.filter((k) => k !== gone.key);
  engRenderPsItems();
}

async function engSaveProduct(ev) {
  ev.preventDefault();
  const body = { action: 'product', product: { id: E.product.id, name: $id('psName').value, description: $id('psDesc').value, items: E.product.items } };
  if (await engPost(body, 'Saved')) modal('psModal').hide();
}

async function engDeleteProduct() {
  if (!confirm(`Delete ${$id('psName').value} and its list items?`)) return;
  if (await engPost({ action: 'deleteProduct', id: E.product.id }, 'Deleted')) modal('psModal').hide();
}

/* ---------- Rate cards ---------- */

function engRenderCards() {
  if (!E.data) return;
  $id('rcListBox').classList.remove('d-none');
  $id('rcEditor').classList.add('d-none');
  const cards = E.data.rateCards;
  if (!cards.length) { $id('rcTable').innerHTML = `<tr><td class="text-muted text-center py-4">No rate cards yet.${engCanEdit() ? ' Create one with New rate card.' : ''}</td></tr>`; return; }
  $id('rcTable').innerHTML = `<thead class="bg-light"><tr><th>Rate card</th><th>Products / services</th><th class="text-end">List items</th><th>Updated</th><th></th></tr></thead><tbody>`
    + cards.map((c) => {
      const products = [...new Set(c.items.map((i) => engItem(i.itemId)?.product).filter(Boolean))];
      return `<tr><td><div class="fw-semibold">${esc(c.name)}</div>${c.description ? `<div class="text-muted">${esc(c.description)}</div>` : ''}</td>
        <td style="white-space:normal">${products.map(esc).join(', ') || '<span class="text-muted">–</span>'}</td><td class="text-end">${c.items.length}</td><td>${esc(c.updatedOn)}</td>
        <td class="text-end text-nowrap"><button class="btn btn-light border btn-sm" onclick="engOpenCard(${c.id})"><i class="fa-solid fa-${engCanEdit() ? 'pen' : 'eye'}"></i> ${engCanEdit() ? 'Edit' : 'View'}</button>
        ${engCanEdit() ? `<button class="btn btn-outline-danger btn-sm" onclick="engDeleteCard(${c.id})" aria-label="Delete ${esc(c.name)}"><i class="fa-solid fa-trash"></i></button>` : ''}</td></tr>`;
    }).join('') + '</tbody>';
}

function engOpenCard(id) {
  const c = id ? E.data.rateCards.find((x) => x.id === id) : null;
  E.card = { id: c ? c.id : null, name: c ? c.name : '', description: c ? c.description : '', items: (c ? c.items : []).map((i) => ({ ...i, prerequisites: [...i.prerequisites] })) };
  $id('rcListBox').classList.add('d-none');
  $id('rcEditor').classList.remove('d-none');
  engRenderCard();
}

function engCloseCard() { E.card = null; engRenderCards(); }

// Adds every list item of a product to the card (items already on it are kept as they are).
function engCardAddProduct() {
  const pid = Number($id('rcAddProduct').value);
  const p = E.data.products.find((x) => x.id === pid);
  if (!p) return;
  if (!p.items.length) return toast(`${p.name} has no list items yet`, false);
  for (const it of p.items) {
    if (!E.card.items.some((i) => i.itemId === it.id)) E.card.items.push({ itemId: it.id, unitPrice: 0, pricingModel: it.pricingModel, mandatory: it.mandatory, prerequisites: [...it.prerequisites] });
  }
  engRenderCard();
}

function engCardAddItem(sel) {
  const it = engItem(Number(sel.value));
  if (it) E.card.items.push({ itemId: it.id, unitPrice: 0, pricingModel: it.pricingModel, mandatory: it.mandatory, prerequisites: [...it.prerequisites] });
  engRenderCard();
}

// The card's rows grouped by product, in master order.
function engGroupRows(rows) {
  const groups = [];
  for (const p of E.data.products) {
    const items = p.items.map((m) => rows.find((r) => r.itemId === m.id)).filter(Boolean);
    if (items.length) groups.push({ product: p, items });
  }
  return groups;
}

function engRenderCard() {
  const c = E.card;
  const ro = !engCanEdit();
  const onCard = new Set(c.items.map((i) => i.itemId));
  const groups = engGroupRows(c.items);
  const changed = (row, m) => row.pricingModel !== m.pricingModel || row.mandatory !== m.mandatory || row.prerequisites.slice().sort().join() !== m.prerequisites.slice().sort().join();
  const prereqOptions = (itemId) => [...onCard].filter((x) => x !== itemId).map((x) => ({ value: String(x), label: engItem(x).name, group: engItem(x).product }));
  $id('rcEditor').innerHTML = `
    <div class="d-flex justify-content-between align-items-center mb-3 gap-2 flex-wrap">
      <button class="btn btn-light border btn-sm" onclick="engCloseCard()"><i class="fa-solid fa-arrow-left me-1"></i>All rate cards</button>
      ${ro ? '' : `<div class="d-flex gap-2"><button class="btn btn-light border btn-sm" onclick="engCloseCard()">Cancel</button><button class="btn btn-primary btn-sm fw-semibold" onclick="engSaveCard()"><i class="fa-solid fa-floppy-disk me-1"></i>Save rate card</button></div>`}
    </div>
    <div class="row g-3 mb-3">
      <div class="col-md-4"><label class="form-label small fw-semibold" for="rcName">Rate card name</label><input id="rcName" class="form-control" maxlength="150" value="${esc(c.name)}" ${ro ? 'disabled' : ''} oninput="E.card.name = this.value"></div>
      <div class="col-md-8"><label class="form-label small fw-semibold" for="rcDesc">Description</label><input id="rcDesc" class="form-control" maxlength="1000" value="${esc(c.description)}" ${ro ? 'disabled' : ''} oninput="E.card.description = this.value"></div>
    </div>
    ${ro ? '' : `<div class="d-flex gap-2 align-items-end mb-3 flex-wrap">
      <div><label class="form-label small fw-semibold" for="rcAddProduct">Add a product / service row</label>
        <select id="rcAddProduct" class="form-select form-select-sm" style="min-width:18rem">${E.data.products.filter((p) => p.items.some((i) => !onCard.has(i.id))).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">All products are on this card</option>'}</select></div>
      <button class="btn btn-light border btn-sm" onclick="engCardAddProduct()"><i class="fa-solid fa-plus me-1"></i>Add with its list items</button>
    </div>`}
    <div class="small text-muted mb-2"><i class="fa-solid fa-circle-info me-1"></i>Pricing model, Mandatory and Prerequisites start as in the master and can be changed for this rate card; changed tags are marked <span class="badge bg-warning-subtle text-warning-emphasis border">edited</span>.</div>
    <div class="table-responsive"><table class="table align-middle small mb-0">
      <thead class="bg-light"><tr><th style="min-width:13rem">List item</th><th style="width:10rem">Pricing model</th><th style="width:5.5rem">Mandatory</th><th style="min-width:13rem">Prerequisites</th><th style="width:10rem" class="text-end">Charge per unit (₹)</th><th style="width:3rem"></th></tr></thead>
      <tbody>${groups.map((g) => {
        const missing = g.product.items.filter((m) => !onCard.has(m.id));
        return `<tr class="table-light"><td colspan="6"><div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <span class="fw-bold">${esc(g.product.name)}</span>
          ${ro ? '' : `<div class="d-flex gap-2 align-items-center">${missing.length ? `<select class="form-select form-select-sm" style="width:auto" aria-label="Add a list item of ${esc(g.product.name)}" onchange="engCardAddItem(this)"><option value="">+ Add a removed item…</option>${missing.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : ''}
            <button class="btn btn-outline-danger btn-sm" onclick="engCardRemoveProduct(${g.product.id})"><i class="fa-solid fa-trash me-1"></i>Remove row</button></div>`}
        </div></td></tr>` + g.items.map((row) => {
          const m = engItem(row.itemId);
          const i = c.items.indexOf(row);
          return `<tr><td class="ps-3">${esc(m.name)} ${changed(row, m) ? `<span class="badge bg-warning-subtle text-warning-emphasis border ms-1" title="Master: ${E.data.pricing[m.pricingModel]}, mandatory ${m.mandatory ? 'Y' : 'N'}">edited</span>${ro ? '' : ` <button type="button" class="btn btn-link btn-sm p-0 ms-1" onclick="engCardReset(${i})">reset</button>`}` : ''}</td>
            <td>${engPricingSelect(row.pricingModel, `E.card.items[${i}].pricingModel = this.value; engRenderCard()`, ro, `Pricing model, ${m.name}`)}</td>
            <td><select class="form-select form-select-sm" aria-label="Mandatory, ${esc(m.name)}" ${ro ? 'disabled' : ''} onchange="E.card.items[${i}].mandatory = this.value === 'Y'; engRenderCard()"><option ${row.mandatory ? '' : 'selected'}>N</option><option ${row.mandatory ? 'selected' : ''}>Y</option></select></td>
            <td>${engMulti(String(row.itemId), prereqOptions(row.itemId), row.prerequisites.map(String), 'engCardPrereq', ro)}</td>
            <td><input type="number" min="0" step="0.01" class="form-control form-control-sm text-end" value="${row.unitPrice || ''}" placeholder="0" ${ro ? 'disabled' : ''} aria-label="Charge per unit, ${esc(m.name)}" oninput="E.card.items[${i}].unitPrice = Number(this.value) || 0"></td>
            <td>${ro ? '' : `<button class="btn btn-outline-danger btn-sm" onclick="engCardRemove(${i})" aria-label="Remove ${esc(m.name)}"><i class="fa-solid fa-xmark"></i></button>`}</td></tr>`;
        }).join('');
      }).join('') || `<tr><td colspan="6" class="text-muted text-center py-4">No products on this card yet.${ro ? '' : ' Add a product / service row above.'}</td></tr>`}</tbody>
    </table></div>`;
}

function engCardPrereq(key, values) { E.card.items.find((i) => String(i.itemId) === key).prerequisites = values.map(Number); }
function engCardReset(i) { const m = engItem(E.card.items[i].itemId); Object.assign(E.card.items[i], { pricingModel: m.pricingModel, mandatory: m.mandatory, prerequisites: [...m.prerequisites] }); engRenderCard(); }
function engCardRemove(i) { const [gone] = E.card.items.splice(i, 1); for (const r of E.card.items) r.prerequisites = r.prerequisites.filter((x) => x !== gone.itemId); engRenderCard(); }
function engCardRemoveProduct(pid) {
  const ids = new Set(E.card.items.filter((r) => engItem(r.itemId).productId === pid).map((r) => r.itemId));
  E.card.items = E.card.items.filter((r) => !ids.has(r.itemId));
  for (const r of E.card.items) r.prerequisites = r.prerequisites.filter((x) => !ids.has(x));
  engRenderCard();
}

async function engSaveCard() {
  // the rows in the order shown (grouped by product)
  const items = engGroupRows(E.card.items).flatMap((g) => g.items);
  const out = await engPost({ action: 'rateCard', rateCard: { ...E.card, items } }, 'Rate card saved');
  if (out) { E.card = null; engRenderCards(); }
}

async function engDeleteCard(id) {
  const c = E.data.rateCards.find((x) => x.id === id);
  if (!confirm(`Delete the rate card ${c.name}? Client plans made from it keep their own copy.`)) return;
  await engPost({ action: 'deleteRateCard', id }, 'Deleted');
}

/* ---------- Engagement plans ---------- */

const engActual = (r) => engR2((Number(r.unitPrice) || 0) * (Number(r.units) || 0));
const engSigned = (r) => (r.signedUp === null || r.signedUp === '' || r.signedUp === undefined ? engActual(r) : engR2(Number(r.signedUp) || 0));
const engVar = (actual, signed) => (actual ? ((signed - actual) / actual) * 100 : signed ? null : 0);
const engTotals = (rows) => { const actual = engR2(rows.reduce((s, r) => s + engActual(r), 0)); const signed = engR2(rows.reduce((s, r) => s + engSigned(r), 0)); return { actual, signed, variation: engVar(actual, signed) }; };

function engRenderPlans() {
  if (!E.data) return;
  $id('cpListBox').classList.remove('d-none');
  $id('cpEditor').classList.add('d-none');
  const words = $id('cpSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const plans = E.data.plans.filter((p) => { const hay = `${p.client} ${p.name}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  if (!plans.length) { $id('cpTable').innerHTML = `<tr><td class="text-muted text-center py-4">${E.data.plans.length ? 'Nothing matches the search.' : 'No engagement plans yet.' + (engCanEdit() ? ' Use Apply rate card to client.' : '')}</td></tr>`; return; }
  $id('cpTable').innerHTML = `<thead class="bg-light"><tr><th>Client</th><th>Plan</th><th>From rate card</th><th class="text-end">Actual price</th><th class="text-end">Signed up</th><th class="text-end">Variation</th><th>Status</th><th></th></tr></thead><tbody>`
    + plans.map((p) => {
      const t = engTotals(p.items);
      const card = E.data.rateCards.find((c) => c.id === p.rateCardId);
      return `<tr><td style="white-space:normal;min-width:12rem">${esc(p.client)}</td><td class="fw-semibold">${esc(p.name)}</td><td>${card ? esc(card.name) : '<span class="text-muted">–</span>'}</td>
        <td class="text-end">${engMoney(t.actual)}</td><td class="text-end fw-semibold">${engMoney(t.signed)}</td><td class="text-end ${t.variation < 0 ? 'text-danger' : t.variation > 0 ? 'text-success' : ''}">${engPct(t.variation)}</td>
        <td>${p.frozenTotal != null ? `<span class="badge badge-soft badge-soft-upcoming" title="Frozen by ${esc(p.frozenBy || '')} on ${esc(p.frozenOn || '')}"><i class="fa-solid fa-lock me-1"></i>Frozen</span>` : '<span class="badge badge-soft badge-soft-pending">Draft</span>'}</td>
        <td class="text-end text-nowrap"><button class="btn btn-light border btn-sm" onclick="engOpenPlan(${p.id})"><i class="fa-solid fa-table-list"></i> Cost structure</button>
        ${engCanEdit() && (p.frozenTotal == null || E.data.admin) ? `<button class="btn btn-outline-danger btn-sm" onclick="engDeletePlan(${p.id})" aria-label="Delete plan ${esc(p.name)}"><i class="fa-solid fa-trash"></i></button>` : ''}</td></tr>`;
    }).join('') + '</tbody>';
}

function engOpenApply() {
  if (!E.data.rateCards.length) return toast('Create a rate card first (Rate Cards tab)', false);
  if (!E.data.clients.length) return toast('Add the client first (Clients tab)', false);
  $id('apClient').innerHTML = E.data.clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $id('apCard').innerHTML = E.data.rateCards.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $id('apName').value = '';
  modal('applyModal').show();
}

async function engApply(ev) {
  ev.preventDefault();
  const out = await engPost({ action: 'apply', clientId: Number($id('apClient').value), rateCardId: Number($id('apCard').value), name: $id('apName').value }, 'Copied');
  if (out) { modal('applyModal').hide(); engOpenPlan(out.id); $id('plans-tab').click(); }
}

function engOpenPlan(id) {
  const p = E.data.plans.find((x) => x.id === id);
  if (!p) return;
  E.plan = { id: p.id, name: p.name, notes: p.notes, client: p.client, rateCardId: p.rateCardId, frozenTotal: p.frozenTotal, frozenOn: p.frozenOn, frozenBy: p.frozenBy,
    items: p.items.map((i) => ({ ...i, prerequisites: [...i.prerequisites] })), dirty: false };
  $id('cpListBox').classList.add('d-none');
  $id('cpEditor').classList.remove('d-none');
  engRenderPlan();
}

function engClosePlan() {
  if (E.plan && E.plan.dirty && !confirm('Leave without saving your changes?')) return;
  E.plan = null;
  engRenderPlans();
}

// Same rules as the server: prerequisites present, and the mandatory items of every product in the plan.
function engPlanProblems() {
  const ids = new Set(E.plan.items.map((r) => r.itemId));
  const card = E.data.rateCards.find((c) => c.id === E.plan.rateCardId);
  const cardProducts = new Set((card ? card.items : []).map((r) => engItem(r.itemId)?.productId));
  const out = [];
  for (const r of E.plan.items) {
    const missing = r.prerequisites.filter((x) => !ids.has(x) && engItem(x));
    if (missing.length) out.push(`"${engItem(r.itemId).name}" needs ${missing.map((x) => `"${engItem(x).name}"`).join(', ')} first`);
  }
  for (const pid of new Set(E.plan.items.map((r) => engItem(r.itemId).productId))) {
    const p = E.data.products.find((x) => x.id === pid);
    for (const m of p.items.filter((i) => !ids.has(i.id))) {
      const required = cardProducts.has(pid) ? card.items.find((r) => r.itemId === m.id)?.mandatory === true : m.mandatory;
      if (required) out.push(`"${m.name}" is mandatory for ${p.name}`);
    }
  }
  return out;
}

// A plan row for an item not yet in the plan: the rate card's charge and tags if it has them, else the master's.
function engPlanRow(itemId) {
  const card = E.data.rateCards.find((c) => c.id === E.plan.rateCardId);
  const fromCard = card && card.items.find((r) => r.itemId === itemId);
  const m = engItem(itemId);
  const src = fromCard || m;
  return { itemId, pricingModel: src.pricingModel, mandatory: src.mandatory, prerequisites: [...src.prerequisites], unitPrice: fromCard ? fromCard.unitPrice : 0, units: 1, signedUp: null };
}

function engPlanAddProduct() {
  const p = E.data.products.find((x) => x.id === Number($id('cpAddProduct').value));
  if (!p) return;
  for (const m of p.items) if (!E.plan.items.some((r) => r.itemId === m.id)) E.plan.items.push(engPlanRow(m.id));
  E.plan.dirty = true;
  engRenderPlan();
}

function engPlanAddItem(sel) {
  const id = Number(sel.value);
  if (id && !E.plan.items.some((r) => r.itemId === id)) { E.plan.items.push(engPlanRow(id)); E.plan.dirty = true; }
  engRenderPlan();
}

function engPlanRemove(i) { E.plan.items.splice(i, 1); E.plan.dirty = true; engRenderPlan(); }

// Live edits update the figures without re-rendering (so the cursor stays put).
function engPlanSet(i, field, value) {
  const r = E.plan.items[i];
  if (field === 'signedUp') r.signedUp = value === '' ? null : Number(value);
  else r[field] = value === '' ? 0 : Number(value);
  E.plan.dirty = true;
  engPlanFigures();
}

function engPlanResetSigned(i) { E.plan.items[i].signedUp = null; E.plan.dirty = true; engRenderPlan(); }

// Updates each row's actual / variation and the totals in place.
function engPlanFigures() {
  E.plan.items.forEach((r, i) => {
    const a = engActual(r), s = engSigned(r), v = engVar(a, s);
    const set = (k, html) => { const el = document.getElementById(`cp-${k}-${i}`); if (el) el.innerHTML = html; };
    set('actual', engMoney(a));
    set('var', `<span class="${v < 0 ? 'text-danger' : v > 0 ? 'text-success' : 'text-muted'}">${engPct(v)}</span>`);
    const inp = document.getElementById(`cp-signed-${i}`);
    if (inp && document.activeElement !== inp && r.signedUp === null) inp.value = a || '';
    if (inp) inp.classList.toggle('border-warning', r.signedUp !== null && engR2(r.signedUp) !== a);
  });
  for (const g of engGroupRows(E.plan.items)) {
    const t = engTotals(g.items);
    const el = document.getElementById(`cp-sub-${g.product.id}`);
    if (el) el.innerHTML = `${engMoney(t.actual)} → <b>${engMoney(t.signed)}</b> <span class="${t.variation < 0 ? 'text-danger' : t.variation > 0 ? 'text-success' : 'text-muted'}">(${engPct(t.variation)})</span>`;
  }
  const t = engTotals(E.plan.items);
  $id('cp-total-actual').textContent = engMoney(t.actual);
  $id('cp-total-signed').textContent = engMoney(t.signed);
  $id('cp-total-var').innerHTML = `<span class="${t.variation < 0 ? 'text-danger' : t.variation > 0 ? 'text-success' : ''}">${engPct(t.variation)}</span>`;
  const fz = $id('cp-frozen');
  if (fz && E.plan.frozenTotal != null) {
    const diff = engR2(E.plan.frozenTotal - t.signed);
    fz.innerHTML = diff === 0 ? '<span class="text-success"><i class="fa-solid fa-circle-check me-1"></i>The signed-up total matches the frozen total.</span>'
      : `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation me-1"></i>Signed up is ${engMoney(Math.abs(diff))} ${diff > 0 ? 'short of' : 'over'} the frozen total. Adjust the signed-up amounts, or</span> <button type="button" class="btn btn-sm btn-outline-primary ms-1" onclick="engBalance()">spread the difference</button>`;
  }
  const problems = engPlanProblems();
  $id('cp-problems').innerHTML = problems.length ? `<div class="alert alert-warning small py-2 mb-3"><b>Before saving:</b> ${problems.map(esc).join('; ')}.</div>` : '';
}

// Spreads the gap to the frozen total over the rows in proportion to their signed-up amounts (the last paisa on the largest).
function engBalance() {
  const rows = E.plan.items;
  const t = engTotals(rows);
  const diff = engR2(E.plan.frozenTotal - t.signed);
  if (!diff) return;
  const base = t.signed || rows.length;
  let left = diff;
  rows.forEach((r) => { const share = engR2(diff * ((t.signed ? engSigned(r) : 1) / base)); r.signedUp = engR2(engSigned(r) + share); left = engR2(left - share); });
  if (left) { const big = rows.reduce((a, b) => (engSigned(b) > engSigned(a) ? b : a)); big.signedUp = engR2(engSigned(big) + left); }
  E.plan.dirty = true;
  engRenderPlan();
}

function engRenderPlan() {
  const P = E.plan;
  const ro = !engCanEdit();
  const frozen = P.frozenTotal != null;
  const inPlan = new Set(P.items.map((r) => r.itemId));
  const groups = engGroupRows(P.items);
  const card = E.data.rateCards.find((c) => c.id === P.rateCardId);
  const addable = E.data.products.filter((p) => p.items.some((i) => !inPlan.has(i.id)));
  $id('cpEditor').innerHTML = `
    <div class="d-flex justify-content-between align-items-center mb-3 gap-2 flex-wrap">
      <button class="btn btn-light border btn-sm" onclick="engClosePlan()"><i class="fa-solid fa-arrow-left me-1"></i>All plans</button>
      ${ro ? '' : `<div class="d-flex gap-2 flex-wrap">
        ${frozen ? (E.data.admin ? '<button class="btn btn-outline-secondary btn-sm" onclick="engUnfreeze()"><i class="fa-solid fa-lock-open me-1"></i>Unfreeze</button>' : '')
          : '<button class="btn btn-outline-primary btn-sm" onclick="engFreeze()" title="Fix the signed-up total; later edits must add up to it"><i class="fa-solid fa-lock me-1"></i>Freeze</button>'}
        <button class="btn btn-primary btn-sm fw-semibold" onclick="engSavePlan()"><i class="fa-solid fa-floppy-disk me-1"></i>Save</button></div>`}
    </div>
    <div class="d-flex flex-wrap gap-3 align-items-start mb-3">
      <div style="flex:1;min-width:16rem"><div class="small text-muted">Client</div><div class="fw-bold">${esc(P.client)}</div>
        <div class="small text-muted mt-1">From rate card: ${card ? esc(card.name) : '<i>deleted or none</i>'}</div></div>
      <div style="flex:1;min-width:14rem"><label class="form-label small fw-semibold mb-1" for="cpName">Plan name</label><input id="cpName" class="form-control form-control-sm" maxlength="150" value="${esc(P.name)}" ${ro ? 'disabled' : ''} oninput="E.plan.name = this.value; E.plan.dirty = true"></div>
      <div style="flex:2;min-width:16rem"><label class="form-label small fw-semibold mb-1" for="cpNotes">Notes</label><input id="cpNotes" class="form-control form-control-sm" maxlength="2000" value="${esc(P.notes)}" ${ro ? 'disabled' : ''} oninput="E.plan.notes = this.value; E.plan.dirty = true"></div>
    </div>
    ${frozen ? `<div class="alert alert-info small py-2 mb-3"><i class="fa-solid fa-lock me-1"></i>Frozen at <b>${engMoney(P.frozenTotal)}</b>${P.frozenBy ? ` by ${esc(P.frozenBy)}` : ''}${P.frozenOn ? ` on ${esc(P.frozenOn)}` : ''}. Items can still change, but the signed-up total must add up to this amount to save. <div id="cp-frozen" class="mt-1"></div></div>` : ''}
    <div id="cp-problems"></div>
    ${ro ? '' : `<div class="d-flex gap-2 align-items-end mb-3 flex-wrap">
      <div><label class="form-label small fw-semibold" for="cpAddProduct">Add a product / service from the master</label>
        <select id="cpAddProduct" class="form-select form-select-sm" style="min-width:18rem">${addable.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">Everything in the master is in this plan</option>'}</select></div>
      <button class="btn btn-light border btn-sm" onclick="engPlanAddProduct()"><i class="fa-solid fa-plus me-1"></i>Add with its list items</button>
    </div>`}
    <div class="table-responsive"><table class="table align-middle small mb-0">
      <thead class="bg-light"><tr><th style="min-width:13rem">List item</th><th>Pricing model</th><th style="width:8rem" class="text-end">Units</th><th style="width:9rem" class="text-end">Unit price (₹)</th>
        <th style="width:9rem" class="text-end">Actual price</th><th style="width:10rem" class="text-end">Signed up (₹)</th><th style="width:6rem" class="text-end">Variation</th><th style="width:3rem"></th></tr></thead>
      <tbody>${groups.map((g) => {
        const missing = g.product.items.filter((m) => !inPlan.has(m.id));
        return `<tr class="table-light"><td colspan="8"><div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <span><span class="fw-bold">${esc(g.product.name)}</span> <span class="small ms-2" id="cp-sub-${g.product.id}"></span></span>
          ${ro || !missing.length ? '' : `<select class="form-select form-select-sm" style="width:auto" aria-label="Add a list item of ${esc(g.product.name)}" onchange="engPlanAddItem(this)"><option value="">+ Add an item…</option>${missing.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>`}
        </div></td></tr>` + g.items.map((r) => {
          const i = P.items.indexOf(r);
          const m = engItem(r.itemId);
          const fixed = r.pricingModel === 'fixed';
          const needs = r.prerequisites.map((x) => engItem(x)?.name).filter(Boolean);
          return `<tr><td class="ps-3">${esc(m.name)}${r.mandatory ? ' <span class="badge badge-soft badge-soft-pending ms-1" style="font-size:10px">Mandatory</span>' : ''}
              ${needs.length ? `<div class="text-muted" style="font-size:11px">Needs: ${needs.map(esc).join(', ')}</div>` : ''}</td>
            <td>${E.data.pricing[r.pricingModel]}</td>
            <td><div class="input-group input-group-sm"><input type="number" min="0" step="any" class="form-control text-end" value="${fixed ? 1 : r.units}" ${fixed || ro ? 'disabled' : ''} aria-label="${UNIT_LABEL[r.pricingModel]}, ${esc(m.name)}" oninput="engPlanSet(${i}, 'units', this.value)"></div>
              <div class="text-muted text-end" style="font-size:10px">${UNIT_LABEL[r.pricingModel]}</div></td>
            <td><input type="number" min="0" step="0.01" class="form-control form-control-sm text-end" value="${r.unitPrice || ''}" placeholder="0" ${ro ? 'disabled' : ''} aria-label="Unit price, ${esc(m.name)}" oninput="engPlanSet(${i}, 'unitPrice', this.value)"></td>
            <td class="text-end" id="cp-actual-${i}"></td>
            <td><input type="number" min="0" step="0.01" id="cp-signed-${i}" class="form-control form-control-sm text-end" value="${engSigned(r) || ''}" ${ro ? 'disabled' : ''} aria-label="Signed up, ${esc(m.name)}" oninput="engPlanSet(${i}, 'signedUp', this.value)" title="Copied from the actual price; change it to record the signed-up amount">
              ${r.signedUp !== null && !ro ? `<button type="button" class="btn btn-link btn-sm p-0 float-end" style="font-size:10px" onclick="engPlanResetSigned(${i})">use actual</button>` : ''}</td>
            <td class="text-end" id="cp-var-${i}"></td>
            <td>${ro ? '' : `<button class="btn btn-outline-danger btn-sm" onclick="engPlanRemove(${i})" aria-label="Remove ${esc(m.name)}"><i class="fa-solid fa-xmark"></i></button>`}</td></tr>`;
        }).join('');
      }).join('') || '<tr><td colspan="8" class="text-muted text-center py-4">No items. Add a product / service above.</td></tr>'}</tbody>
      <tfoot><tr class="fw-bold border-top"><td colspan="4" class="text-end">Total</td><td class="text-end" id="cp-total-actual"></td><td class="text-end" id="cp-total-signed"></td><td class="text-end" id="cp-total-var"></td><td></td></tr></tfoot>
    </table></div>`;
  engPlanFigures();
}

const engPlanBody = () => ({ id: E.plan.id, name: E.plan.name, notes: E.plan.notes,
  items: engGroupRows(E.plan.items).flatMap((g) => g.items).map((r) => ({ itemId: r.itemId, unitPrice: r.unitPrice, units: r.units, signedUp: r.signedUp })) });

async function engSavePlan() {
  const out = await engPost({ action: 'plan', plan: engPlanBody() }, 'Saved');
  if (out) engOpenPlan(E.plan.id);
}

async function engFreeze() {
  if (E.plan.dirty) {
    if (!confirm('Save your changes and freeze the plan?')) return;
    if (!(await engPost({ action: 'plan', plan: engPlanBody() }, 'Saved'))) return;
  }
  const t = engTotals(E.plan.items);
  if (!confirm(`Freeze this plan at ${engMoney(t.signed)}? Later edits must keep the signed-up total at this amount.`)) return;
  if (await engPost({ action: 'freeze', id: E.plan.id }, 'Frozen')) engOpenPlan(E.plan.id);
}

async function engUnfreeze() {
  if (!confirm('Unfreeze this plan? The signed-up total will be free to change.')) return;
  if (await engPost({ action: 'unfreeze', id: E.plan.id }, 'Unfrozen')) engOpenPlan(E.plan.id);
}

async function engDeletePlan(id) {
  const p = E.data.plans.find((x) => x.id === id);
  if (!confirm(`Delete the plan ${p.name} for ${p.client}?`)) return;
  await engPost({ action: 'deletePlan', id }, 'Deleted');
}
