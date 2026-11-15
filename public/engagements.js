// Receivables · Products & Services, Rate Cards and Engagement Plans (talks to /api/engagements).
// Admin and Finance Admin edit; Management sees the same screens read-only.
// Uses $id, toast and modal from invoice-automator.js, and esc / formatINR from the page.
const E = { data: null, loading: null, product: null, card: null, plan: null, newKey: 0 };
const UNIT_SHORT = { per_head: 'hd', per_head_month: 'hd×mo', per_batch: 'bt', per_hour: 'hr', per_day: 'day', per_month: 'mo', fixed: 'fix' };
const UNIT_LABEL = { per_head: 'Head count', per_head_month: 'Heads × months', per_batch: 'Batches', per_hour: 'Hours', per_day: 'Days', per_month: 'Months', fixed: 'Fixed' };
const engR2 = (n) => Math.round(n * 100) / 100;
const engMoney = (n) => formatINR(Number(n) || 0);
const engPct = (n) => (n === null || !Number.isFinite(n) ? '–' : `${n.toFixed(1)}%`);
// Profitability index colour: below 100% red, above green, at 100% plain.
const engPiClass = (n, plain = '') => (n === null || !Number.isFinite(n) ? plain : n < 99.95 ? 'text-danger' : n > 100.05 ? 'text-success' : plain);
const engItem = (id) => E.itemMap.get(id);
const engCanEdit = () => E.data && E.data.canEdit;
const engEmployee = (id) => (E.data.employees.find((u) => u.id === id) || {}).name;

function startEngagements() {
  document.querySelectorAll('.eng-only').forEach((el) => el.classList.remove('d-none'));
  ['products-tab', 'ratecards-tab', 'plans-tab'].forEach((id) => $id(id).addEventListener('shown.bs.tab', () => engLoad()));
}

// Loads (once, or again after a save) everything the three tabs need.
async function engLoad(force = false) {
  if (E.data && !force) return engRenderAll();
  if (E.loading) return E.loading;
  E.loading = (async () => {
    const finish = busy('Loading…');
    try {
      const res = await fetch('/api/engagements', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load products and rate cards');
      engSetData(data);
    } catch (e) {
      ['psList'].forEach((id) => ($id(id).innerHTML = `<div class="text-danger py-3">${esc(e.message)}</div>`));
    } finally {
      E.loading = null;
      finish();
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
  if (E.busy) { toast('Still saving the last change, one moment…', false); return null; }
  E.busy = true;
  const finish = busy('Saving…');
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
  } finally {
    E.busy = false;
    finish();
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
  const list = E.data.products.filter((p) => { const hay = [p.name, p.description, ...p.items.map((i) => `${i.name} ${i.notes} ${i.employeeIds.map(engEmployee).join(' ')}`)].join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); });
  if (!list.length) {
    $id('psList').innerHTML = `<div class="text-muted text-center py-4">${E.data.products.length ? 'Nothing matches the search.' : 'No products or services yet.' + (engCanEdit() ? ' Add the first one.' : '')}</div>`;
    return;
  }
  $id('psList').innerHTML = `<div class="text-end mb-2">${engAllToggles('ps:', list.map((p) => p.id), 'engRenderProducts')}</div>` + list.map((p) => `
    <div class="border rounded-3 mb-3">
      <div class="d-flex justify-content-between align-items-start gap-2 px-3 py-2">
        <div class="d-flex"><div class="pt-0">${engChevron(`ps:${p.id}`, 'engRenderProducts', p.name)}</div><div><span class="fw-bold">${esc(p.name)}</span> <span class="text-muted small ms-1">${p.items.length} item${p.items.length === 1 ? '' : 's'}</span>${p.description ? `<div class="small text-muted">${esc(p.description)}</div>` : ''}</div></div>
        ${engCanEdit() ? `<button class="btn btn-light border btn-sm" onclick="engOpenProduct(${p.id})"><i class="fa-solid fa-pen"></i> Edit</button>` : ''}
      </div>
      <div class="table-responsive ${E.collapsed.has(`ps:${p.id}`) ? 'd-none' : ''}"><table class="table table-sm align-middle small mb-0">
        <thead class="bg-light"><tr><th class="ps-3">List item</th><th>Pricing model</th><th>Mandatory</th><th>Prerequisites</th><th>Employees</th><th>Notes</th></tr></thead>
        <tbody>${p.items.map((it) => `<tr><td class="ps-3">${esc(it.name)}</td><td>${E.data.pricing[it.pricingModel]}</td>
          <td>${it.mandatory ? '<span class="badge badge-soft badge-soft-pending">Y</span>' : '<span class="text-muted">N</span>'}</td>
          <td>${it.prerequisites.map((x) => esc(engItem(x)?.name || '?')).join(', ') || '<span class="text-muted">–</span>'}</td>
          <td>${it.employeeIds.map((x) => esc(engEmployee(x) || '?')).join(', ') || '<span class="text-muted">–</span>'}</td>
          <td style="white-space:pre-wrap;min-width:10rem">${esc(it.notes) || '<span class="text-muted">–</span>'}</td></tr>`).join('')
          || '<tr><td colspan="6" class="ps-3 text-muted">No list items yet.</td></tr>'}</tbody></table></div>
    </div>`).join('');
}

function engOpenProduct(id) {
  const p = id ? E.data.products.find((x) => x.id === id) : null;
  E.product = { id: p ? p.id : null, items: (p ? p.items : []).map((it) => ({ key: String(it.id), id: it.id, name: it.name, pricingModel: it.pricingModel, mandatory: it.mandatory, prerequisites: it.prerequisites.map(String), notes: it.notes, employeeIds: it.employeeIds.map(String) })) };
  if (!p) engAddPsItem(false);
  $id('psTitle').textContent = p ? `Edit ${p.name}` : 'Add product / service';
  $id('psName').value = p ? p.name : '';
  $id('psDesc').value = p ? p.description : '';
  $id('psDelete').classList.toggle('d-none', !p);
  engRenderPsItems();
  modal('psModal').show();
}

function engAddPsItem(render = true) {
  E.product.items.push({ key: `n${++E.newKey}`, id: null, name: '', pricingModel: 'per_head', mandatory: false, prerequisites: [], notes: '', employeeIds: [] });
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
  $id('psItems').innerHTML = `<thead class="bg-light"><tr><th style="min-width:14rem">List item</th><th style="width:11rem">Pricing model</th><th style="width:6rem">Mandatory</th><th style="min-width:13rem">Prerequisites</th><th style="min-width:12rem">Employees (optional)</th><th style="min-width:14rem">Notes</th><th style="width:3rem"></th></tr></thead><tbody>`
    + rows.map((it, n) => `<tr>
      <td><input class="form-control form-control-sm" value="${esc(it.name)}" maxlength="200" required aria-label="List item ${n + 1} name" oninput="E.product.items[${n}].name = this.value" onchange="engRenderPsItems()"></td>
      <td>${engPricingSelect(it.pricingModel, `E.product.items[${n}].pricingModel = this.value`, false, `Pricing model, item ${n + 1}`)}</td>
      <td><select class="form-select form-select-sm" aria-label="Mandatory, item ${n + 1}" onchange="E.product.items[${n}].mandatory = this.value === 'Y'">
        <option ${it.mandatory ? '' : 'selected'}>N</option><option ${it.mandatory ? 'selected' : ''}>Y</option></select></td>
      <td>${engMulti(it.key, engPsPrereqOptions(it.key), it.prerequisites, 'engPsPrereq')}</td>
      <td>${engMulti(it.key, E.data.employees.map((u) => ({ value: String(u.id), label: u.name })), it.employeeIds, 'engPsEmployees')}</td>
      <td><textarea class="form-control form-control-sm" rows="1" maxlength="1000" aria-label="Notes, item ${n + 1}" oninput="E.product.items[${n}].notes = this.value">${esc(it.notes)}</textarea></td>
      <td><button type="button" class="btn btn-outline-danger btn-sm" onclick="engRemovePsItem(${n})" aria-label="Remove list item ${n + 1}"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join('')
    + (rows.length ? '' : '<tr><td colspan="7" class="text-muted">No list items. Add one.</td></tr>') + '</tbody>';
}

function engPsPrereq(key, values) { E.product.items.find((i) => i.key === key).prerequisites = values; }
function engPsEmployees(key, values) { E.product.items.find((i) => i.key === key).employeeIds = values; }

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
  $id('rcTable').innerHTML = `<thead class="bg-light"><tr><th>Rate card</th><th>Products / services</th><th class="text-end">List items</th><th>Updated</th></tr></thead><tbody>`
    + cards.map((c) => {
      const products = [...new Set(c.items.map((i) => engItem(i.itemId)?.product).filter(Boolean))];
      return `<tr style="cursor:pointer" onclick="engOpenCard(${c.id})" title="${engCanEdit() ? 'Click to edit' : 'Click to view'}">
        <td><a href="#" class="fw-semibold text-decoration-none" onclick="event.preventDefault()">${esc(c.name)}</a>${c.description ? `<div class="text-muted">${esc(c.description)}</div>` : ''}</td>
        <td style="white-space:normal">${products.map(esc).join(', ') || '<span class="text-muted">–</span>'}</td><td class="text-end">${c.items.length}</td><td>${esc(c.updatedOn)}</td></tr>`;
    }).join('') + '</tbody>';
}

// A copy of a rate card, opened unsaved (Save creates it).
function engDuplicateCard() {
  const src = E.card;
  const names = new Set(E.data.rateCards.map((c) => c.name.toLowerCase()));
  let name = `${src.name} (copy)`;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${src.name} (copy ${n})`;
  E.card = { id: null, name, description: src.description, items: src.items.map((i) => ({ ...i, prerequisites: [...i.prerequisites] })) };
  engRenderCard();
  toast('Copy opened. Change what you need, then Save rate card.');
  $id('rcName').focus();
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

// Rows grouped by product in their own order (groups by first appearance), so rows and sections can be dragged.
function engGroups(rows) {
  const groups = [];
  for (const r of rows) {
    const pid = engItem(r.itemId).productId;
    let g = groups.find((x) => x.product.id === pid);
    if (!g) groups.push((g = { product: E.data.products.find((p) => p.id === pid), items: [] }));
    g.items.push(r);
  }
  return groups;
}
const engPlanGroups = engGroups;

// Moves a whole product section before / after another one.
function engMoveGroup(rows, fromPid, toPid) {
  const gs = engGroups(rows);
  const f = gs.findIndex((g) => g.product.id === fromPid), t = gs.findIndex((g) => g.product.id === toPid);
  if (f < 0 || t < 0 || f === t) return false;
  engMove(gs, f, t);
  rows.splice(0, rows.length, ...gs.flatMap((g) => g.items));
  return true;
}
// A row moves within its own product section.
function engMoveRowIn(rows, from, to) {
  if (from === to || !rows[from] || !rows[to] || engItem(rows[from].itemId).productId !== engItem(rows[to].itemId).productId) return false;
  engMove(rows, from, to);
  return true;
}

/* ---------- collapsible sections ---------- */
// Keys: ps:<product id> (product list), rc:<product id> (rate card), cp:<product id> (plan). Kept for this browser.
E.collapsed = new Set((() => { try { return JSON.parse(localStorage.getItem('engCollapsed') || '[]'); } catch { return []; } })());
function engToggle(key, render) {
  E.collapsed.has(key) ? E.collapsed.delete(key) : E.collapsed.add(key);
  try { localStorage.setItem('engCollapsed', JSON.stringify([...E.collapsed])); } catch { /* private window */ }
  window[render]();
}
function engToggleAll(prefix, ids, collapse, render) {
  for (const id of ids) collapse ? E.collapsed.add(prefix + id) : E.collapsed.delete(prefix + id);
  try { localStorage.setItem('engCollapsed', JSON.stringify([...E.collapsed])); } catch { /* private window */ }
  window[render]();
}
const engChevron = (key, render, label) => `<button type="button" class="btn btn-link btn-sm p-0 me-2 text-reset" style="width:1rem" onclick="engToggle('${key}', '${render}')"
  aria-expanded="${!E.collapsed.has(key)}" aria-label="${E.collapsed.has(key) ? 'Expand' : 'Collapse'} ${esc(label)}"><i class="fa-solid fa-chevron-${E.collapsed.has(key) ? 'right' : 'down'}"></i></button>`;
const engAllToggles = (prefix, ids, render) => ids.length ? `<span class="small"><button type="button" class="btn btn-link btn-sm p-0" onclick='engToggleAll("${prefix}", ${JSON.stringify(ids)}, false, "${render}")'>Expand all</button> ·
  <button type="button" class="btn btn-link btn-sm p-0" onclick='engToggleAll("${prefix}", ${JSON.stringify(ids)}, true, "${render}")'>Collapse all</button></span>` : '';

function engRenderCard() {
  const c = E.card;
  const ro = !engCanEdit();
  const onCard = new Set(c.items.map((i) => i.itemId));
  const groups = engGroups(c.items);
  const changed = (row, m) => row.pricingModel !== m.pricingModel || row.mandatory !== m.mandatory || row.prerequisites.slice().sort().join() !== m.prerequisites.slice().sort().join();
  const prereqOptions = (itemId) => [...onCard].filter((x) => x !== itemId).map((x) => ({ value: String(x), label: engItem(x).name, group: engItem(x).product }));
  $id('rcEditor').innerHTML = `
    <div class="d-flex justify-content-between align-items-center mb-3 gap-2 flex-wrap">
      <button class="btn btn-light border btn-sm" onclick="engCloseCard()"><i class="fa-solid fa-arrow-left me-1"></i>All rate cards</button>
      ${ro ? '' : `<div class="d-flex gap-2 align-items-center">
        ${c.id ? `<button class="btn btn-outline-danger btn-sm" onclick="engDeleteCard(${c.id})" title="Delete this rate card" aria-label="Delete this rate card"><i class="fa-solid fa-trash"></i></button>
          <button class="btn btn-light border btn-sm" onclick="engDuplicateCard()" title="Make a copy of this rate card"><i class="fa-solid fa-copy me-1"></i>Duplicate</button>` : '<span class="badge bg-info-subtle text-info-emphasis border">New, not saved yet</span>'}
        <button class="btn btn-light border btn-sm" onclick="engCloseCard()">Cancel</button><button class="btn btn-primary btn-sm fw-semibold" onclick="engSaveCard()"><i class="fa-solid fa-floppy-disk me-1"></i>Save rate card</button></div>`}
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
    <div class="d-flex justify-content-between align-items-end gap-2 flex-wrap mb-2">
      <div class="small text-muted"><i class="fa-solid fa-circle-info me-1"></i>Pricing model, Mandatory and Prerequisites start as in the master and can be changed for this rate card; changed tags are marked <span class="badge bg-warning-subtle text-warning-emphasis border">edited</span>.${ro ? '' : ' Drag a section or a row by its <i class="fa-solid fa-grip-vertical"></i> handle to reorder.'}</div>
      ${engAllToggles('rc:', groups.map((g) => g.product.id), 'engRenderCard')}</div>
    <div class="table-responsive"><table class="table align-middle small mb-0">
      <thead class="bg-light"><tr><th style="min-width:13rem">List item</th><th style="width:10rem">Pricing model</th><th style="width:5.5rem">Mandatory</th><th style="min-width:13rem">Prerequisites</th><th style="width:10rem" class="text-end">Charge per unit (₹)</th><th style="width:3rem"></th></tr></thead>
      <tbody>${groups.map((g) => {
        const missing = g.product.items.filter((m) => !onCard.has(m.id));
        const shut = E.collapsed.has(`rc:${g.product.id}`);
        return `<tr class="table-light" ${ro ? '' : engDragAttrs('cgrp', g.product.id)}><td colspan="6"><div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <span>${ro ? '' : engGrip()}${engChevron(`rc:${g.product.id}`, 'engRenderCard', g.product.name)}<span class="fw-bold">${esc(g.product.name)}</span> <span class="text-muted small ms-1">${g.items.length} item${g.items.length > 1 ? 's' : ''}</span></span>
          ${ro ? '' : `<div class="d-flex gap-2 align-items-center">${missing.length ? `<select class="form-select form-select-sm" style="width:auto" aria-label="Add a list item of ${esc(g.product.name)}" onchange="engCardAddItem(this)"><option value="">+ Add a removed item…</option>${missing.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>` : ''}
            <button class="btn btn-outline-danger btn-sm" onclick="engCardRemoveProduct(${g.product.id})"><i class="fa-solid fa-trash me-1"></i>Remove row</button></div>`}
        </div></td></tr>` + (shut ? '' : g.items.map((row) => {
          const m = engItem(row.itemId);
          const i = c.items.indexOf(row);
          return `<tr ${ro ? '' : engDragAttrs('crow', i)}><td class="ps-3">${ro ? '' : engGrip()}${esc(m.name)} ${changed(row, m) ? `<span class="badge bg-warning-subtle text-warning-emphasis border ms-1" title="Master: ${E.data.pricing[m.pricingModel]}, mandatory ${m.mandatory ? 'Y' : 'N'}">edited</span>${ro ? '' : ` <button type="button" class="btn btn-link btn-sm p-0 ms-1" onclick="engCardReset(${i})">reset</button>`}` : ''}</td>
            <td>${engPricingSelect(row.pricingModel, `E.card.items[${i}].pricingModel = this.value; engRenderCard()`, ro, `Pricing model, ${m.name}`)}</td>
            <td><select class="form-select form-select-sm" aria-label="Mandatory, ${esc(m.name)}" ${ro ? 'disabled' : ''} onchange="E.card.items[${i}].mandatory = this.value === 'Y'; engRenderCard()"><option ${row.mandatory ? '' : 'selected'}>N</option><option ${row.mandatory ? 'selected' : ''}>Y</option></select></td>
            <td>${engMulti(String(row.itemId), prereqOptions(row.itemId), row.prerequisites.map(String), 'engCardPrereq', ro)}</td>
            <td><input type="number" min="0" step="0.01" class="form-control form-control-sm text-end" value="${row.unitPrice || ''}" placeholder="0" ${ro ? 'disabled' : ''} aria-label="Charge per unit, ${esc(m.name)}" oninput="E.card.items[${i}].unitPrice = Number(this.value) || 0"></td>
            <td>${ro ? '' : `<button class="btn btn-outline-danger btn-sm" onclick="engCardRemove(${i})" aria-label="Remove ${esc(m.name)}"><i class="fa-solid fa-xmark"></i></button>`}</td></tr>`;
        }).join(''));
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
  const items = engGroups(E.card.items).flatMap((g) => g.items);
  const out = await engPost({ action: 'rateCard', rateCard: { ...E.card, items } }, 'Rate card saved');
  if (out) { E.card = null; engRenderCards(); }
}

async function engDeleteCard(id) {
  const c = E.data.rateCards.find((x) => x.id === id);
  if (!confirm(`Delete the rate card ${c.name}? Client plans made from it keep their own copy.`)) return;
  if (await engPost({ action: 'deleteRateCard', id }, 'Deleted')) { E.card = null; engRenderCards(); }
}

/* ---------- Engagement plans ---------- */

// Per Head-Monthly: unit price x heads x months.
const engActual = (r) => engR2((Number(r.unitPrice) || 0) * (Number(r.units) || 0) * (r.pricingModel === 'per_head_month' ? Number(r.months ?? 1) || 0 : 1));
const engSigned = (r) => (r.signedUp === null || r.signedUp === '' || r.signedUp === undefined ? engActual(r) : engR2(Number(r.signedUp) || 0));
// Profitability index = signed up as % of the actual price (₹62,500 of ₹1,00,000 = 62.5%; 100% = signed at the actual price).
const engVar = (actual, signed) => (actual ? (signed / actual) * 100 : null);
const engTotals = (rows) => { const actual = engR2(rows.reduce((s, r) => s + engActual(r), 0)); const signed = engR2(rows.reduce((s, r) => s + engSigned(r), 0)); return { actual, signed, variation: engVar(actual, signed) }; };

function engRenderPlans() {
  if (!E.data) return;
  $id('cpListBox').classList.remove('d-none');
  $id('cpEditor').classList.add('d-none');
  const words = $id('cpSearch').value.toLowerCase().split(/\s+/).filter(Boolean);
  const plans = E.data.plans.filter((p) => { const hay = `${p.client} ${p.name}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  if (!plans.length) { $id('cpTable').innerHTML = `<tr><td class="text-muted text-center py-4">${E.data.plans.length ? 'Nothing matches the search.' : 'No engagement plans yet.' + (engCanEdit() ? ' Use Apply rate card to client.' : '')}</td></tr>`; return; }
  const drag = engCanEdit() && !words.length; // the order is the whole list's, so no dragging while searching
  $id('cpTable').innerHTML = `<thead class="bg-light"><tr><th>Client</th><th>Plan</th><th>From rate card</th><th class="text-end">Actual price</th><th class="text-end">Signed up</th><th class="text-end">Profitability index</th><th>Status</th><th></th></tr></thead><tbody>`
    + plans.map((p) => {
      const t = engTotals(p.items);
      const card = E.data.rateCards.find((c) => c.id === p.rateCardId);
      return `<tr ${drag ? `ondragstart="engDragStart(event, 'plan', ${p.id})" ondragend="engDragEnd(event)" ondragover="engDragOver(event, 'plan')" ondrop="engDropPlan(event, ${p.id})"` : ''}>
        <td style="white-space:normal;min-width:12rem">${drag ? engGrip() : ''}${esc(p.client)}</td><td class="fw-semibold">${esc(p.name)}</td><td>${card ? esc(card.name) : '<span class="text-muted">–</span>'}</td>
        <td class="text-end">${engMoney(t.actual)}</td><td class="text-end fw-semibold">${engMoney(t.signed)}</td><td class="text-end ${engPiClass(t.variation)}">${engPct(t.variation)}</td>
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
    items: p.items.map((i) => ({ ...i, prerequisites: [...i.prerequisites] })), schedule: (p.schedule || []).map((x) => ({ ...x })), dirty: false };
  $id('cpListBox').classList.add('d-none');
  $id('cpEditor').classList.remove('d-none');
  engRenderPlan();
}

function engClosePlan() {
  if (E.plan && E.plan.dirty && !confirm('Leave without saving your changes?')) return;
  E.plan = null;
  engRenderPlans();
}

// Same rules as the server: a taken item (units above 0) needs its prerequisites taken, and every product in the plan
// needs its mandatory items taken. Also marks the rows at fault (E.plan.bad: item ids).
const engTaken = (r) => r.pricingModel === 'fixed' || (Number(r.units) > 0 && (r.pricingModel !== 'per_head_month' || Number(r.months ?? 1) > 0));
function engPlanProblems() {
  const ids = new Set(E.plan.items.filter(engTaken).map((r) => r.itemId));
  const listed = new Set(E.plan.items.map((r) => r.itemId));
  const bad = new Set();
  const card = E.data.rateCards.find((c) => c.id === E.plan.rateCardId);
  const cardProducts = new Set((card ? card.items : []).map((r) => engItem(r.itemId)?.productId));
  const out = [];
  for (const r of E.plan.items.filter(engTaken)) {
    const missing = r.prerequisites.filter((x) => !ids.has(x) && engItem(x));
    if (missing.length) {
      bad.add(r.itemId); missing.forEach((x) => bad.add(x));
      out.push(`"${engItem(r.itemId).name}" needs ${missing.map((x) => `"${engItem(x).name}"${listed.has(x) ? ' (its units are 0)' : ''}`).join(', ')} first`);
    }
  }
  for (const pid of new Set(E.plan.items.map((r) => engItem(r.itemId).productId))) {
    const p = E.data.products.find((x) => x.id === pid);
    for (const m of p.items.filter((i) => !ids.has(i.id))) {
      const required = cardProducts.has(pid) ? card.items.find((r) => r.itemId === m.id)?.mandatory === true : m.mandatory;
      if (required) out.push(`"${m.name}" is mandatory for ${p.name}${listed.has(m.id) ? ' (its units are 0)' : ''}`);
    }
  }
  // mandatory items that are listed but have no units
  for (const r of E.plan.items.filter((x) => !engTaken(x))) if (out.some((t) => t.startsWith(`"${engItem(r.itemId).name}" is mandatory`))) bad.add(r.itemId);
  E.plan.bad = bad;
  return out;
}

// A plan row for an item not yet in the plan: the rate card's charge and tags if it has them, else the master's.
function engPlanRow(itemId) {
  const card = E.data.rateCards.find((c) => c.id === E.plan.rateCardId);
  const fromCard = card && card.items.find((r) => r.itemId === itemId);
  const m = engItem(itemId);
  const src = fromCard || m;
  return { itemId, pricingModel: src.pricingModel, mandatory: src.mandatory, prerequisites: [...src.prerequisites], unitPrice: fromCard ? fromCard.unitPrice : 0, units: 1, months: src.pricingModel === 'per_head_month' ? 1 : null, signedUp: null, notes: '' };
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

function engPlanRemove(i) {
  const gone = E.plan.items[i];
  const needers = E.plan.items.filter((r) => r !== gone && r.prerequisites.includes(gone.itemId)).map((r) => engItem(r.itemId).name);
  const name = engItem(gone.itemId).name;
  if (needers.length && !confirm(`${needers.join(', ')} ${needers.length > 1 ? 'need' : 'needs'} "${name}" first. Remove it anyway? The plan can't be saved until that is sorted out.`)) return;
  if (!needers.length && gone.mandatory && !confirm(`"${name}" is mandatory. Remove it anyway? The plan can't be saved without it.`)) return;
  E.plan.items.splice(i, 1);
  E.plan.dirty = true;
  engRenderPlan();
}

// Live edits update the figures without re-rendering (so the cursor stays put).
function engPlanSet(i, field, value) {
  const r = E.plan.items[i];
  if (field === 'signedUp') r.signedUp = value === '' ? null : Number(value);
  else if (field === 'notes') r.notes = value;
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
    set('var', `<span class="${engPiClass(v, 'text-muted')}">${engPct(v)}</span>`);
    const inp = document.getElementById(`cp-signed-${i}`);
    if (inp && document.activeElement !== inp && r.signedUp === null) inp.value = a || '';
    if (inp) inp.classList.toggle('border-warning', r.signedUp !== null && engR2(r.signedUp) !== a);
  });
  for (const g of engPlanGroups(E.plan.items)) {
    const t = engTotals(g.items);
    const el = document.getElementById(`cp-sub-${g.product.id}`);
    if (el) el.innerHTML = `${engMoney(t.actual)} → <b>${engMoney(t.signed)}</b> <span class="${engPiClass(t.variation, 'text-muted')}">(${engPct(t.variation)})</span>`;
  }
  const t = engTotals(E.plan.items);
  $id('cp-total-actual').textContent = engMoney(t.actual);
  $id('cp-total-signed').textContent = engMoney(t.signed);
  $id('cp-total-var').innerHTML = `<span class="${engPiClass(t.variation)}">${engPct(t.variation)}</span>`;
  const fz = $id('cp-frozen');
  if (fz && E.plan.frozenTotal != null) {
    const diff = engR2(E.plan.frozenTotal - t.signed);
    fz.innerHTML = diff === 0 ? '<span class="text-success"><i class="fa-solid fa-circle-check me-1"></i>The signed-up total matches the frozen total.</span>'
      : `<span class="text-danger"><i class="fa-solid fa-triangle-exclamation me-1"></i>Signed up is ${engMoney(Math.abs(diff))} ${diff > 0 ? 'short of' : 'over'} the frozen total. Adjust the signed-up amounts, or</span> <button type="button" class="btn btn-sm btn-outline-primary ms-1" onclick="engBalance()">spread the difference</button>`;
  }
  const problems = engPlanProblems();
  E.plan.items.forEach((r, i) => document.getElementById(`cp-actual-${i}`)?.closest('tr').classList.toggle('table-danger', E.plan.bad.has(r.itemId)));
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

/* ---------- drag to reorder (plans in the list, rows in a plan) ---------- */
// Only the grip handle starts a drag, so text in the row's inputs can still be selected.
let engDrag = null;
function engGrip() {
  return `<span class="text-muted me-2" style="cursor:grab" title="Drag to reorder" aria-hidden="true"
    onmousedown="this.closest('tr').draggable = true" ontouchstart="this.closest('tr').draggable = true"><i class="fa-solid fa-grip-vertical"></i></span>`;
}
function engDragStart(ev, kind, key) {
  engDrag = { kind, key };
  if (ev.dataTransfer) { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(key)); }
  ev.currentTarget.classList.add('opacity-50');
}
function engDragEnd(ev) { ev.currentTarget.draggable = false; ev.currentTarget.classList.remove('opacity-50'); engDrag = null; }
function engDragOver(ev, kind) { if (engDrag && engDrag.kind === kind) { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; } }
const engMove = (list, from, to) => { const [x] = list.splice(from, 1); list.splice(to, 0, x); };

// Plan rows move within their own product.
function engDropRow(ev, to) {
  ev.preventDefault();
  if (!engDrag || engDrag.kind !== 'row') return;
  const from = engDrag.key;
  engDrag = null;
  engPlanMoveRow(from, to);
}
function engPlanMoveRow(from, to) {
  if (!engMoveRowIn(E.plan.items, from, to)) return;
  E.plan.dirty = true;
  engRenderPlan();
}

// Drag attributes for a row; dropping calls the kind's mover.
const engDragAttrs = (kind, key) => `ondragstart="engDragStart(event, '${kind}', ${key})" ondragend="engDragEnd(event)" ondragover="engDragOver(event, '${kind}')" ondrop="engDrop(event, '${kind}', ${key})"`;
const ENG_MOVERS = {
  row: (f, t) => engPlanMoveRow(f, t),
  pgrp: (f, t) => { if (engMoveGroup(E.plan.items, f, t)) { E.plan.dirty = true; engRenderPlan(); } },
  crow: (f, t) => { if (engMoveRowIn(E.card.items, f, t)) engRenderCard(); },
  cgrp: (f, t) => { if (engMoveGroup(E.card.items, f, t)) engRenderCard(); },
};
function engDrop(ev, kind, to) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!engDrag || engDrag.kind !== kind) return;
  const from = engDrag.key;
  engDrag = null;
  ENG_MOVERS[kind](from, to);
}

// Plans in the list: dropped onto another plan's row, saved straight away.
function engDropPlan(ev, toId) {
  ev.preventDefault();
  if (!engDrag || engDrag.kind !== 'plan') return;
  const fromId = engDrag.key;
  engDrag = null;
  engMovePlan(fromId, toId);
}
async function engMovePlan(fromId, toId) {
  const plans = E.data.plans;
  const from = plans.findIndex((p) => p.id === fromId), to = plans.findIndex((p) => p.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  engMove(plans, from, to);
  engRenderPlans();
  await engPost({ action: 'reorderPlans', ids: plans.map((p) => p.id) }, 'Order saved');
}

function engRenderPlan() {
  const P = E.plan;
  const ro = !engCanEdit();
  const frozen = P.frozenTotal != null;
  const inPlan = new Set(P.items.map((r) => r.itemId));
  const groups = engPlanGroups(P.items);
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
    <div class="d-flex justify-content-between align-items-end gap-2 flex-wrap mb-2">
      <div class="small text-muted">${ro ? '' : '<i class="fa-solid fa-grip-vertical me-1"></i>Drag a section, or a row within its section, by the handle to reorder.'}</div>
      ${engAllToggles('cp:', groups.map((g) => g.product.id), 'engRenderPlan')}</div>
    ${ro ? '' : `<div class="d-flex gap-2 align-items-end mb-3 flex-wrap">
      <div><label class="form-label small fw-semibold" for="cpAddProduct">Add a product / service from the master</label>
        <select id="cpAddProduct" class="form-select form-select-sm" style="min-width:18rem">${addable.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">Everything in the master is in this plan</option>'}</select></div>
      <button class="btn btn-light border btn-sm" onclick="engPlanAddProduct()"><i class="fa-solid fa-plus me-1"></i>Add with its list items</button>
    </div>`}
    <div class="table-responsive"><table class="table align-middle small mb-0">
      <thead class="bg-light"><tr><th style="min-width:13rem">List item</th><th>Pricing model</th><th style="min-width:9rem" class="text-end">Units</th><th style="width:9rem" class="text-end">Unit price (₹)</th>
        <th style="width:9rem" class="text-end">Actual price</th><th style="width:10rem" class="text-end">Signed up (₹)</th><th style="width:7rem" class="text-end" title="Signed up as % of the actual price (100% = signed at the actual price)">Profitability index</th><th style="min-width:12rem">Notes</th><th style="width:3rem"></th></tr></thead>
      <tbody>${groups.map((g) => {
        const missing = g.product.items.filter((m) => !inPlan.has(m.id));
        const shut = E.collapsed.has(`cp:${g.product.id}`);
        return `<tr class="table-light" ${ro ? '' : engDragAttrs('pgrp', g.product.id)}><td colspan="9"><div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <span>${ro ? '' : engGrip()}${engChevron(`cp:${g.product.id}`, 'engRenderPlan', g.product.name)}<span class="fw-bold">${esc(g.product.name)}</span> <span class="small ms-2" id="cp-sub-${g.product.id}"></span></span>
          ${ro || !missing.length ? '' : `<select class="form-select form-select-sm" style="width:auto" aria-label="Add a list item of ${esc(g.product.name)}" onchange="engPlanAddItem(this)"><option value="">+ Add an item…</option>${missing.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>`}
        </div></td></tr>` + (shut ? '' : g.items.map((r) => {
          const i = P.items.indexOf(r);
          const m = engItem(r.itemId);
          const fixed = r.pricingModel === 'fixed';
          const needs = r.prerequisites.map((x) => engItem(x)?.name).filter(Boolean);
          const perMonth = r.pricingModel === 'per_head_month';
          return `<tr ${ro ? '' : engDragAttrs('row', i)}>
            <td class="ps-3">${ro ? '' : engGrip()}${esc(m.name)}${r.mandatory ? ' <span class="badge badge-soft badge-soft-pending ms-1" style="font-size:10px">Mandatory</span>' : ''}
              ${needs.length ? `<div class="text-muted" style="font-size:11px">Needs: ${needs.map(esc).join(', ')}</div>` : ''}</td>
            <td>${E.data.pricing[r.pricingModel]}</td>
            <td>${perMonth ? `<div class="d-flex flex-column gap-1">
                <div class="input-group input-group-sm flex-nowrap" style="min-width:6.5rem"><input type="number" min="0" step="any" class="form-control form-control-sm text-end" style="min-width:3.5rem" value="${r.units}" ${ro ? 'disabled' : ''} aria-label="Head count, ${esc(m.name)}" oninput="engPlanSet(${i}, 'units', this.value)"><span class="input-group-text px-1 py-0 small" title="Head count">hd</span></div>
                <div class="input-group input-group-sm flex-nowrap" style="min-width:6.5rem"><input type="number" min="0" step="any" class="form-control form-control-sm text-end" style="min-width:3.5rem" value="${r.months ?? 1}" ${ro ? 'disabled' : ''} aria-label="Months, ${esc(m.name)}" oninput="engPlanSet(${i}, 'months', this.value)"><span class="input-group-text px-1 py-0 small" title="Months">mo</span></div></div>`
              : `<div class="input-group input-group-sm flex-nowrap" style="min-width:6.5rem"><input type="number" min="0" step="any" class="form-control form-control-sm text-end" style="min-width:3.5rem" value="${fixed ? 1 : r.units}" ${fixed || ro ? 'disabled' : ''} aria-label="${UNIT_LABEL[r.pricingModel]}, ${esc(m.name)}" oninput="engPlanSet(${i}, 'units', this.value)"><span class="input-group-text px-1 py-0 small" title="${UNIT_LABEL[r.pricingModel]}">${UNIT_SHORT[r.pricingModel]}</span></div>`}</td>
            <td><input type="number" min="0" step="0.01" class="form-control form-control-sm text-end" value="${r.unitPrice || ''}" placeholder="0" ${ro ? 'disabled' : ''} aria-label="Unit price, ${esc(m.name)}" oninput="engPlanSet(${i}, 'unitPrice', this.value)"></td>
            <td class="text-end" id="cp-actual-${i}"></td>
            <td><div class="input-group input-group-sm flex-nowrap"><input type="number" min="0" step="0.01" id="cp-signed-${i}" class="form-control form-control-sm text-end" value="${engSigned(r) || ''}" ${ro ? 'disabled' : ''} aria-label="Signed up, ${esc(m.name)}" oninput="engPlanSet(${i}, 'signedUp', this.value)" title="Copied from the actual price; change it to record the signed-up amount">
              ${r.signedUp !== null && !ro ? `<button type="button" class="btn btn-light border px-1 py-0" title="Use the actual price again" aria-label="Use the actual price for ${esc(m.name)}" onclick="engPlanResetSigned(${i})"><i class="fa-solid fa-rotate-left"></i></button>` : ''}</div></td>
            <td class="text-end" id="cp-var-${i}"></td>
            <td><textarea class="form-control form-control-sm" rows="1" maxlength="1000" ${ro ? 'disabled' : ''} aria-label="Notes, ${esc(m.name)}" oninput="engPlanSet(${i}, 'notes', this.value)">${esc(r.notes || '')}</textarea></td>
            <td>${ro ? '' : `<button class="btn btn-outline-danger btn-sm" onclick="engPlanRemove(${i})" aria-label="Remove ${esc(m.name)}"><i class="fa-solid fa-xmark"></i></button>`}</td></tr>`;
        }).join(''));
      }).join('') || '<tr><td colspan="9" class="text-muted text-center py-4">No items. Add a product / service above.</td></tr>'}</tbody>
      <tfoot><tr class="fw-bold border-top"><td colspan="4" class="text-end">Total</td><td class="text-end" id="cp-total-actual"></td><td class="text-end" id="cp-total-signed"></td><td class="text-end" id="cp-total-var"></td><td colspan="2"></td></tr></tfoot>
    </table></div>
    <div class="border rounded-3 p-3 mt-3" id="cpSchedule"></div>`;
  engPlanFigures();
  engRenderSchedule();
}

/* ---------- invoice schedule: the signed-up total split into dated invoices ---------- */

// What the invoices must add up to: the frozen total, else the current signed-up total.
const engScheduleTarget = () => (E.plan.frozenTotal != null ? E.plan.frozenTotal : engTotals(E.plan.items).signed);
const engIsoAddMonths = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 + n, 1)); const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate(); t.setUTCDate(Math.min(d, last)); return t.toISOString().slice(0, 10); };
const engIsoAddDays = (iso, n) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const engTodayIso = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };

// Splits what is left (target minus generated invoices) equally over the rows not generated yet; dates a month apart.
function engSplit() {
  const n = Math.round(Number($id('cpInvCount').value));
  const done = E.plan.schedule.filter((x) => x.invoiceId);
  if (!(n >= 1 && n <= 60)) return toast('Enter the number of invoices (1 to 60)', false);
  if (n < done.length) return toast(`${done.length} invoice(s) are already generated, so the number can't be lower than that`, false);
  const left = engR2(engScheduleTarget() - done.reduce((s, x) => s + x.amount, 0));
  const k = n - done.length;
  const old = E.plan.schedule.filter((x) => !x.invoiceId);
  const lastDone = done.map((x) => x.invoiceDate).sort().pop();
  let date = old[0]?.invoiceDate || (lastDone ? engIsoAddMonths(lastDone, 1) : engTodayIso());
  const each = k ? Math.floor((left / k) * 100) / 100 : 0;
  const rows = Array.from({ length: k }, (_, i) => {
    const invoiceDate = old[i]?.invoiceDate || date;
    const row = { amount: i === k - 1 ? engR2(left - each * (k - 1)) : each, invoiceDate,
      particulars: old[i]?.particulars || `${E.plan.name} - Invoice ${done.length + i + 1}`, dueDate: old[i]?.dueDate || engIsoAddDays(invoiceDate, 45), poNumber: old[i]?.poNumber || '' };
    date = engIsoAddMonths(invoiceDate, 1);
    return row;
  });
  E.plan.schedule = [...done, ...rows];
  E.plan.dirty = true;
  engRenderSchedule();
}

function engSchedSet(i, field, value) {
  const row = E.plan.schedule[i];
  // a due date still at the default 45 days follows the invoice date
  if (field === 'invoiceDate' && value && (!row.dueDate || (row.invoiceDate && row.dueDate === engIsoAddDays(row.invoiceDate, 45)))) {
    row.dueDate = engIsoAddDays(value, 45);
    const due = document.getElementById(`cp-due-${i}`); if (due) due.value = row.dueDate;
  }
  row[field] = field === 'amount' ? Number(value) || 0 : value;
  E.plan.dirty = true;
  engScheduleTotals();
}

function engScheduleTotals() {
  const sum = engR2(E.plan.schedule.reduce((s, x) => s + (Number(x.amount) || 0), 0));
  const target = engR2(engScheduleTarget());
  const diff = engR2(target - sum);
  const el = $id('cpSchedTotal');
  if (el) el.innerHTML = `${engMoney(sum)} ${!E.plan.schedule.length ? '' : diff === 0 ? '<span class="text-success small ms-1"><i class="fa-solid fa-circle-check"></i> matches</span>'
    : `<span class="text-danger small ms-1">${engMoney(Math.abs(diff))} ${diff > 0 ? 'short of' : 'over'} ${engMoney(target)}</span>`}`;
  const btn = $id('cpGenerate');
  if (btn) btn.disabled = !(E.plan.frozenTotal != null && diff === 0 && E.plan.schedule.some((x) => !x.invoiceId));
}

const ENG_INV_STATUS = { NEW_ENTRY: 'New entry', APPROVED: 'Approved', REMINDER: 'Emailed', 'PAYMENT RECEIVED': 'Paid' };
function engRenderSchedule() {
  const P = E.plan;
  const ro = !engCanEdit();
  const frozen = P.frozenTotal != null;
  const rows = P.schedule;
  const done = rows.filter((x) => x.invoiceId).length;
  $id('cpSchedule').innerHTML = `
    <div class="d-flex justify-content-between align-items-start gap-2 flex-wrap mb-2">
      <div><h3 class="h6 fw-bold mb-1"><i class="fa-solid fa-file-invoice me-1"></i>Invoices to the client</h3>
        <div class="small text-muted">The signed-up total is split into this many invoices. <b>Generate invoices</b> creates a Finance Team request (with these particulars and PO number) and a new service invoice in Receivables → Manage Invoices for each; their dates can be changed there until approved. Each invoice is accounted to the items above in proportion to their signed-up amounts.</div></div>
      ${ro ? '' : `<div class="d-flex gap-2 align-items-end">
        <div><label class="form-label small fw-semibold mb-1" for="cpInvCount">Number of invoices</label>
          <input type="number" id="cpInvCount" min="1" max="60" class="form-control form-control-sm" style="width:6rem" value="${rows.length || ''}" placeholder="e.g. 4"></div>
        <button class="btn btn-light border btn-sm" onclick="engSplit()"><i class="fa-solid fa-divide me-1"></i>Split</button></div>`}
    </div>
    ${rows.length ? `<div class="table-responsive"><table class="table align-middle small mb-2">
      <thead class="bg-light"><tr><th style="width:2.5rem">#</th><th style="min-width:14rem">Particulars</th><th style="width:9.5rem">Invoice date</th><th style="width:9.5rem">Due date</th><th style="min-width:8rem">PO number <span class="fw-normal text-muted">(optional)</span></th><th style="width:10rem" class="text-end">Amount (₹, excl. GST)</th><th>Status</th></tr></thead>
      <tbody>${rows.map((x, i) => { const lock = ro || x.invoiceId ? 'disabled' : ''; return `<tr>
        <td>${i + 1}</td>
        <td><input class="form-control form-control-sm" maxlength="1000" value="${esc(x.particulars || '')}" placeholder="${esc(`${P.name} - Invoice ${i + 1}`)}" ${lock} aria-label="Invoice ${i + 1} particulars" oninput="engSchedSet(${i}, 'particulars', this.value)"></td>
        <td><input type="date" class="form-control form-control-sm" value="${esc(x.invoiceDate || '')}" ${lock} aria-label="Invoice ${i + 1} date" onchange="engSchedSet(${i}, 'invoiceDate', this.value)"></td>
        <td><input type="date" id="cp-due-${i}" class="form-control form-control-sm" value="${esc(x.dueDate || '')}" ${lock} aria-label="Invoice ${i + 1} due date" onchange="engSchedSet(${i}, 'dueDate', this.value)"></td>
        <td><input class="form-control form-control-sm" maxlength="300" value="${esc(x.poNumber || '')}" placeholder="N/A" ${lock} aria-label="Invoice ${i + 1} PO number" oninput="engSchedSet(${i}, 'poNumber', this.value)"></td>
        <td><input type="number" min="0" step="0.01" class="form-control form-control-sm text-end" value="${x.amount || ''}" ${ro || x.invoiceId ? 'disabled' : ''} aria-label="Invoice ${i + 1} amount" oninput="engSchedSet(${i}, 'amount', this.value)"></td>
        <td>${x.invoiceId ? `<span class="badge badge-soft badge-soft-received">${esc(ENG_INV_STATUS[String(x.status || '').toUpperCase()] || x.status || 'Generated')}</span>${x.invoiceNumber ? ` <span class="text-muted">${esc(x.invoiceNumber)}</span>` : ''}`
          : '<span class="text-muted">Not generated</span>'}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr class="fw-bold"><td colspan="5" class="text-end">Total</td><td class="text-end" id="cpSchedTotal" colspan="2"></td></tr></tfoot></table></div>` : '<div class="small text-muted">No invoices planned yet.' + (ro ? '' : ' Enter the number of invoices and click Split.') + '</div>'}
    ${ro ? '' : `<div class="d-flex gap-2 align-items-center flex-wrap">
      <button class="btn btn-primary btn-sm fw-semibold" id="cpGenerate" onclick="engGenerate()"><i class="fa-solid fa-paper-plane me-1"></i>Generate invoices</button>
      <span class="small text-muted">${!frozen ? '<i class="fa-solid fa-lock me-1"></i>Freeze the plan first, so the total is fixed.' : done ? `${done} of ${rows.length} generated.` : 'Generates every row that isn\'t generated yet.'}</span></div>`}`;
  engScheduleTotals();
}

async function engGenerate() {
  const todo = E.plan.schedule.filter((x) => !x.invoiceId);
  if (!confirm(`Create ${todo.length} invoice request${todo.length > 1 ? 's' : ''} for ${E.plan.client}?\n\n${todo.map((x) => `• ${x.invoiceDate.split('-').reverse().join('/')}: ${engMoney(x.amount)}`).join('\n')}\n\nEach becomes a Finance Team request and a new entry in Manage Invoices.`)) return;
  if (E.plan.dirty && !(await engPost({ action: 'plan', plan: engPlanBody() }, 'Saved'))) return;
  if (await engPost({ action: 'generateInvoices', id: E.plan.id }, 'Generated')) engOpenPlan(E.plan.id);
}

const engPlanBody = () => ({ id: E.plan.id, name: E.plan.name, notes: E.plan.notes, schedule: E.plan.schedule.filter((x) => !x.invoiceId).map((x) => ({ amount: x.amount, invoiceDate: x.invoiceDate, dueDate: x.dueDate, particulars: x.particulars, poNumber: x.poNumber })),
  items: engPlanGroups(E.plan.items).flatMap((g) => g.items).map((r) => ({ itemId: r.itemId, pricingModel: r.pricingModel, mandatory: r.mandatory, prerequisites: r.prerequisites, unitPrice: r.unitPrice, units: r.units,
    months: r.pricingModel === 'per_head_month' ? r.months ?? 1 : null, signedUp: r.signedUp, notes: r.notes })) });

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
