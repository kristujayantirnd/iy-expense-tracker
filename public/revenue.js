// Revenue Planner · Revenue dashboard: income by product / service, by employee and by month, from the invoices in
// Receivables (amounts without GST). Plan-generated invoices are split across the plan's items (invoice_allocations);
// other invoices show as "Not from a plan". An item tagged to several employees credits them equally.
// Status follows the Receivables dashboard: Received (payment received), Upcoming (new entry / no invoice number),
// Receivable (everything else). Uses E (engagements.js) for the masters and esc / formatINR from the page.
const RV = { data: null, open: new Set() };
const RV_STATUS = [['received', 'Received'], ['receivable', 'Receivable'], ['upcoming', 'Upcoming']];
const rvStatus = (inv) => {
  const st = String(inv.status || '').trim();
  if (st.toLowerCase() === 'payment received') return 'received';
  return !String(inv.invoiceNumber || '').trim() || st.toUpperCase() === 'NEW_ENTRY' ? 'upcoming' : 'receivable';
};
const rvR2 = (n) => Math.round(n * 100) / 100;
// ₹ in K / L / Cr for axis labels
const rvShort = (n) => { const a = Math.abs(n); return '₹' + (a >= 1e7 ? (n / 1e7).toFixed(1).replace(/\.0$/, '') + 'Cr' : a >= 1e5 ? (n / 1e5).toFixed(1).replace(/\.0$/, '') + 'L' : a >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : Math.round(n)); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// India financial year (April to March) containing a date.
function rvFy(d = new Date()) { const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; return [`${y}-04-01`, `${y + 1}-03-31`]; }

async function rvLoad() {
  const finish = busy('Loading…');
  try {
    const res = await fetch('/api/engagements?view=revenue', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not load the revenue');
    engSetData(data); // masters for the other tabs too
    RV.data = data;
    const clients = [...new Set(data.invoices.map((i) => i.client))].sort((a, b) => a.localeCompare(b));
    $id('rvClient').innerHTML = '<option value="">All clients</option>' + clients.map((c) => `<option>${esc(c)}</option>`).join('');
    if (!$id('rvFrom').value && !$id('rvTo').value) rvPreset('fy');
    else rvRender();
  } catch (e) {
    $id('rvBody').innerHTML = `<div class="alert alert-danger">${esc(e.message)}</div>`;
  } finally {
    finish();
  }
}

function rvPreset(kind) {
  const [f, t] = kind === 'fy' ? rvFy() : kind === 'lastfy' ? rvFy(new Date(new Date().getFullYear() - 1, new Date().getMonth(), 1)) : ['', ''];
  $id('rvFrom').value = f;
  $id('rvTo').value = t;
  document.querySelectorAll('[data-rv-preset]').forEach((b) => b.classList.toggle('active', b.dataset.rvPreset === kind));
  rvRender();
}

// Amounts per (key, status) for the invoices in the filter.
function rvCompute() {
  const from = $id('rvFrom').value, to = $id('rvTo').value, client = $id('rvClient').value;
  const items = new Map();
  for (const p of E.data.products) for (const it of p.items) items.set(it.id, { ...it, product: p.name });
  const inv = RV.data.invoices.filter((i) => (!from || (i.date && i.date >= from)) && (!to || (i.date && i.date <= to)) && (!client || i.client === client));
  const byInv = new Map(inv.map((i) => [i.id, i]));
  const allocs = RV.data.allocations.filter((a) => byInv.has(a.invoiceId));
  const groups = { product: new Map(), item: new Map(), employee: new Map(), month: new Map() };
  const add = (g, key, label, st, amt, extra = {}) => {
    if (!g.has(key)) g.set(key, { key, label, received: 0, receivable: 0, upcoming: 0, total: 0, ...extra });
    const row = g.get(key); row[st] += amt; row.total += amt;
  };
  const totals = { received: 0, receivable: 0, upcoming: 0, total: 0, unplanned: 0 };
  const NOPLAN = 'Not from a plan';
  for (const i of inv) {
    const st = rvStatus(i);
    totals[st] += i.amount; totals.total += i.amount;
    const m = (i.date || '').slice(0, 7);
    if (m) add(groups.month, m, `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`, st, i.amount);
    const own = allocs.filter((a) => a.invoiceId === i.id);
    const rest = rvR2(i.amount - own.reduce((s, a) => s + a.amount, 0));
    if (rest > 0.004) { add(groups.product, '_none', NOPLAN, st, rest, { muted: true }); add(groups.employee, '_none', NOPLAN, st, rest, { muted: true }); totals.unplanned += rest; }
    for (const a of own) {
      const it = items.get(a.itemId);
      const pname = it ? it.product : 'Removed item';
      add(groups.product, 'p' + (it ? it.productId : 0), pname, st, a.amount);
      add(groups.item, a.itemId, it ? it.name : 'Removed item', st, a.amount, { productKey: 'p' + (it ? it.productId : 0) });
      // the plan row's own employees and split if it has them, else the list item's
      const row = (E.data.plans.find((p) => p.id === a.planId)?.items || []).find((r) => r.itemId === a.itemId);
      const own = row && Array.isArray(row.employeeIds);
      const emps = own ? row.employeeIds : it ? it.employeeIds : [];
      if (!emps.length) add(groups.employee, '_untagged', 'No employee tagged', st, a.amount, { muted: true });
      else {
        // percent split, else equal shares
        const split = (own ? row.employeeSplit : it.employeeSplit) || {};
        const set = emps.length > 1 && emps.some((e) => Number(split[e]) > 0);
        for (const e of emps) add(groups.employee, 'e' + e, engEmployee(e) || 'Former employee', st, a.amount * (set ? (Number(split[e]) || 0) / 100 : 1 / emps.length));
      }
    }
  }
  const sorted = (g) => [...g.values()].map((r) => ({ ...r, received: rvR2(r.received), receivable: rvR2(r.receivable), upcoming: rvR2(r.upcoming), total: rvR2(r.total) }))
    .sort((a, b) => (a.muted - b.muted) || b.total - a.total);
  return { totals, invoices: inv.length, product: sorted(groups.product), item: sorted(groups.item), employee: sorted(groups.employee),
    month: [...groups.month.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

/* ---------- charts (plain HTML: thin stacked bars, hover tooltips, a table under each) ---------- */

function rvTip(ev, html) {
  const t = $id('rvTip');
  if (!html) { t.classList.add('d-none'); return; }
  t.innerHTML = html;
  t.classList.remove('d-none');
  const x = Math.min(ev.clientX + 14, window.innerWidth - t.offsetWidth - 8), y = Math.max(ev.clientY - t.offsetHeight - 10, 8);
  t.style.left = x + 'px'; t.style.top = y + 'px';
}
const rvTipHtml = (label, row, st) => `<div class="fw-semibold mb-1">${esc(label)}</div>`
  + RV_STATUS.map(([k, name]) => `<div class="d-flex justify-content-between gap-3 ${k === st ? 'fw-semibold' : ''}"><span><span class="rv-sw rv-${k}"></span>${name}</span><span>${formatINR(row[k])}</span></div>`).join('')
  + `<div class="d-flex justify-content-between gap-3 border-top mt-1 pt-1"><span>Total</span><span class="fw-semibold">${formatINR(row.total)}</span></div>`;

// Horizontal stacked bars, one row per entry, scaled to the largest total.
function rvBars(rows, id) {
  if (!rows.length) return '<div class="text-muted small py-3">No revenue in this period.</div>';
  const max = Math.max(...rows.map((r) => r.total), 1);
  window['rvRows_' + id] = rows;
  return `<div class="rv-bars" role="img" aria-label="Bar chart; the table below has the figures">` + rows.map((r, n) => `
    <div class="rv-bar-row">
      <div class="rv-bar-label ${r.muted ? 'text-muted fst-italic' : ''}" title="${esc(r.label)}">${esc(r.label)}</div>
      <div class="rv-bar-track">
        <div class="rv-bar" style="width:${Math.max((r.total / max) * 100, 0.5)}%">${RV_STATUS.filter(([k]) => r[k] > 0).map(([k]) =>
          `<span class="rv-seg rv-${k}" style="flex:${r[k]}" onmousemove="rvTip(event, rvTipHtml(rvRows_${id}[${n}].label, rvRows_${id}[${n}], '${k}'))" onmouseleave="rvTip(event)"></span>`).join('')}</div>
        <span class="rv-bar-value">${rvShort(r.total)}</span>
      </div>
    </div>`).join('') + '</div>';
}

// Monthly stacked columns with a recessive grid.
function rvColumns(rows) {
  if (!rows.length) return '<div class="text-muted small py-3">No invoices in this period.</div>';
  const max = Math.max(...rows.map((r) => r.total), 1);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const ticks = [0, 0.5, 1].map((f) => top * f);
  window.rvRows_month = rows;
  return `<div class="rv-cols-wrap" role="img" aria-label="Column chart by month; the table below has the figures">
    <div class="rv-cols-axis">${ticks.slice().reverse().map((t) => `<span>${rvShort(t)}</span>`).join('')}</div>
    <div class="rv-cols">${ticks.map((t) => `<div class="rv-grid" style="bottom:${(t / top) * 100}%"></div>`).join('')}
      ${rows.map((r, n) => `<div class="rv-col-slot"><div class="rv-col" style="height:${(r.total / top) * 100}%">${RV_STATUS.slice().reverse().filter(([k]) => r[k] > 0).map(([k]) =>
        `<span class="rv-cseg rv-${k}" style="flex:${r[k]}" onmousemove="rvTip(event, rvTipHtml(rvRows_month[${n}].label, rvRows_month[${n}], '${k}'))" onmouseleave="rvTip(event)"></span>`).join('')}</div>
        <div class="rv-col-label">${esc(r.label)}</div></div>`).join('')}</div></div>`;
}

function rvTable(rows, label, expandable = false, items = []) {
  if (!rows.length) return '';
  const cells = (r) => RV_STATUS.map(([k]) => `<td class="text-end">${r[k] ? formatINR(r[k]) : '<span class="text-muted">–</span>'}</td>`).join('') + `<td class="text-end fw-semibold">${formatINR(r.total)}</td>`;
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  return `<div class="table-responsive mt-2"><table class="table table-sm align-middle small mb-0">
    <thead class="bg-light"><tr><th>${label}</th>${RV_STATUS.map(([, n]) => `<th class="text-end">${n}</th>`).join('')}<th class="text-end">Total</th></tr></thead><tbody>`
    + rows.map((r) => {
      const kids = expandable ? items.filter((i) => i.productKey === r.key) : [];
      const open = RV.open.has(r.key);
      return `<tr><td>${kids.length ? `<button type="button" class="btn btn-link btn-sm p-0 me-1 text-reset" onclick="rvToggle('${r.key}')" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} items of ${esc(r.label)}"><i class="fa-solid fa-chevron-${open ? 'down' : 'right'}"></i></button>` : ''}<span class="${r.muted ? 'text-muted fst-italic' : 'fw-semibold'}">${esc(r.label)}</span></td>${cells(r)}</tr>`
        + (open ? kids.map((k) => `<tr class="text-muted"><td class="ps-4">${esc(k.label)}</td>${cells(k)}</tr>`).join('') : '');
    }).join('')
    + `</tbody><tfoot><tr class="fw-bold border-top"><td>Total</td>${RV_STATUS.map(([k]) => `<td class="text-end">${formatINR(sum(k))}</td>`).join('')}<td class="text-end">${formatINR(sum('total'))}</td></tr></tfoot></table></div>`;
}

function rvToggle(key) { RV.open.has(key) ? RV.open.delete(key) : RV.open.add(key); rvRender(); }

// Each widget shows its chart; the table under it stays folded until asked for (remembered in this browser).
let rvShown = new Set();
try { rvShown = new Set(JSON.parse(localStorage.getItem('rvTables') || '[]')); } catch { /* private window */ }
function rvTableToggle(key) {
  rvShown.has(key) ? rvShown.delete(key) : rvShown.add(key);
  try { localStorage.setItem('rvTables', JSON.stringify([...rvShown])); } catch { /* private window */ }
  rvRender();
}
function rvWidget(key, title, note, chart, table, cls) {
  const open = rvShown.has(key);
  return `<div class="${cls}"><div class="filter-card p-3 h-100">
    <div class="d-flex align-items-start gap-2 mb-2"><div class="me-auto"><h2 class="h6 fw-bold mb-0">${title}</h2>${note ? `<div class="small text-muted">${note}</div>` : ''}</div>
      ${table ? `<button type="button" class="btn btn-light border btn-sm py-0 text-nowrap" onclick="rvTableToggle('${key}')" aria-expanded="${open}"><i class="fa-solid fa-chevron-${open ? 'up' : 'down'} me-1"></i>${open ? 'Hide' : 'Show'} table</button>` : ''}</div>
    ${chart}${open ? table : ''}</div></div>`;
}

function rvRender() {
  if (!RV.data) return;
  const c = rvCompute();
  const tile = (label, v, cls, note) => `<div class="col-6 col-lg-3"><div class="metric-card h-100"><div class="metric-title">${cls ? `<span class="rv-sw rv-${cls}"></span>` : ''}${label}</div>
    <div class="metric-value">${formatINR(v)}</div><small class="text-muted">${note}</small></div></div>`;
  $id('rvBody').innerHTML = `
    <div class="row g-3 mb-3">
      ${tile('Total revenue', c.totals.total, '', `${c.invoices} invoice${c.invoices === 1 ? '' : 's'}${c.totals.unplanned ? ` · ${formatINR(c.totals.unplanned)} not from a plan` : ''}`)}
      ${tile('Received', c.totals.received, 'received', c.totals.total ? `${((c.totals.received / c.totals.total) * 100).toFixed(1)}% of the total` : '–')}
      ${tile('Receivable', c.totals.receivable, 'receivable', 'Invoiced, not yet paid')}
      ${tile('Upcoming', c.totals.upcoming, 'upcoming', 'Not invoiced to the client yet')}
    </div>
    <div class="d-flex gap-3 small mb-2 flex-wrap" aria-label="Legend">${RV_STATUS.map(([k, n]) => `<span><span class="rv-sw rv-${k}"></span>${n}</span>`).join('')}
      <span class="text-muted ms-auto">Service invoices only (reimbursements are left out). All amounts exclude GST. Hover a bar for the split.</span></div>
    <div class="row g-3">
      ${rvWidget('month', 'By month (invoice date)', '', rvColumns(c.month), rvTable(c.month, 'Month'), 'col-12')}
      ${rvWidget('product', 'By product / service', '', rvBars(c.product, 'product'), rvTable(c.product, 'Product / service', true, c.item), 'col-lg-6')}
      ${rvWidget('employee', 'By employee', "From each plan row's employees and split (set in the plan, else in Products &amp; Services; equal shares if no split).", rvBars(c.employee, 'employee'), rvTable(c.employee, 'Employee'), 'col-lg-6')}
    </div>`;
}
