// Client Invoice Automator on the Receivables page (Admin and Finance Admin only).
// Talks to /api/client-invoices; the sheet rows and Gmail are reached through the sheet's Apps Script.
let inv = { config: null, clients: [], rows: [], admin: false };

const TEMPLATES = [
  { key: 'requestTemplate', label: 'Finance Team request email', vars: ['InvoiceType', 'Client', 'PO_Number', 'ItemDescription', 'AmountwithoutGST', 'InvoiceDate'] },
  { key: 'firstTemplate', label: 'First email to the client (invoice attached)', vars: ['Client Name', 'ContactPoint', 'Invoice number', 'Due Date', 'InvoiceType'] },
  { key: 'reminderTemplate', label: 'Reminder email (reply in the same thread)', vars: ['Client Name', 'ContactPoint', 'Invoice number', 'Due Date', 'InvoiceType'] },
];
const SAMPLE = {
  InvoiceType: 'Service', Client: 'SAMPLE CLIENT PVT LTD', 'Client Name': 'SAMPLE CLIENT PVT LTD', PO_Number: 'N/A', ItemDescription: 'Retainer fee - Nov',
  AmountwithoutGST: '₹5,00,000.00', InvoiceDate: '01/11/2026', ContactPoint: 'Asha', 'Invoice number': 'VD/2026-27/99', 'Due Date': '16/12/2026',
};
const ROW_STATUS = { NEW_ENTRY: 'New entry', APPROVED: 'Approved', REMINDER: 'Emailed · reminders on', 'Payment Received': 'Payment received' };
const $id = (id) => document.getElementById(id);
// Live search: every typed word must appear somewhere in the row's text (case-insensitive).
const matches = (inputId, ...fields) => { const words = $id(inputId).value.toLowerCase().split(/\s+/).filter(Boolean); const hay = fields.join(' ').toLowerCase(); return words.every((w) => hay.includes(w)); };
const isPaid = (r) => r.status.toLowerCase() === 'payment received';
const localToday = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const modal = (id) => bootstrap.Modal.getOrCreateInstance($id(id));

function toast(msg, ok = true) {
  const el = $id('iyToast');
  el.className = `position-fixed bottom-0 end-0 m-3 alert shadow ${ok ? 'alert-success' : 'alert-danger'}`;
  el.innerText = msg;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('d-none'), ok ? 4000 : 9000);
}

// POST an action; returns the reply, or null after showing the error.
async function invPost(body, done) {
  try {
    const res = await fetch('/api/client-invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    inv.config = data.config;
    inv.clients = data.clients;
    toast(data.notice || done);
    return data;
  } catch (e) {
    toast(e.message, false);
    return null;
  }
}

async function startAutomator(admin) {
  inv.admin = admin;
  document.querySelectorAll('.manage-only').forEach((el) => el.classList.remove('d-none'));
  if (admin) document.querySelectorAll('.admin-only').forEach((el) => el.classList.remove('d-none'));
  $id('templateFields').innerHTML = TEMPLATES.map((t) => `
    <div class="mb-3">
      <div class="d-flex justify-content-between align-items-end gap-2">
        <label class="form-label small fw-semibold mb-1" for="cfg-${t.key}">${t.label}</label>
        <button type="button" class="btn btn-light border btn-sm mb-1" onclick="previewTemplate('${t.key}')"><i class="fa-solid fa-eye me-1"></i>Preview</button>
      </div>
      <textarea id="cfg-${t.key}" class="form-control font-monospace" rows="4" style="font-size:12px"></textarea>
      <div class="form-text">Placeholders: ${t.vars.map((v) => `<code>{{${v}}}</code>`).join(' ')}</div>
    </div>`).join('');
  $id('manage-tab').addEventListener('shown.bs.tab', () => { if (!inv.rows.length) loadRows(); });
  const res = await fetch('/api/client-invoices');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return toast(data.error || 'Could not load the automator settings', false);
  Object.assign(inv, { config: data.config, clients: data.clients });
  renderClients();
  fillConfig();
  if (admin) {
    $id('cfgScript').value = data.script || '';
    const code = await fetch('/apps-script/InvoiceAutomator.gs').then((r) => r.text()).catch(() => '');
    $id('scriptCode').value = code.replace('__APP_URL__', location.origin).replace('__KEY__', data.key);
  }
}

/* ---------- Manage invoices ---------- */

async function loadRows() {
  $id('manageTable').innerHTML = '<tr><td class="text-muted py-4 text-center">Loading from the sheet…</td></tr>';
  try {
    const res = await fetch('/api/client-invoices?rows=1', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not read the sheet');
    inv.rows = data.rows || [];
    renderManage();
  } catch (e) {
    $id('manageTable').innerHTML = `<tr><td class="text-danger py-4">${esc(e.message)}</td></tr>`;
  }
}

function renderManage() {
  const open = $id('manageShow').value === 'open';
  const list = inv.rows.filter((r) => (!open || !isPaid(r)) && matches('manageSearch', r.client, r.invoiceNumber, r.invoiceDate, r.dueDate, r.status, ROW_STATUS[r.status] || '', r.amount)).slice().reverse(); // newest first
  if (!list.length) { $id('manageTable').innerHTML = `<tr><td class="text-muted py-4 text-center">${inv.rows.length ? 'No invoices match.' : 'No invoices to show.'}</td></tr>`; return; }
  $id('manageTable').innerHTML = `<thead class="bg-light"><tr><th>Client</th><th>Invoice No</th><th>Invoice Date</th><th class="text-end">Amount (w/o GST)</th><th>Due</th><th>PDF</th><th>Status</th><th></th></tr></thead><tbody>`
    + list.map((r) => {
      const link = safeLink(r.pdfUrl);
      const ready = ['NEW_ENTRY', 'APPROVED'].includes(r.status.toUpperCase()) && r.invoiceNumber && link;
      return `<tr>
        <td style="white-space:normal;min-width:12rem">${esc(r.client)}</td>
        <td class="fw-semibold">${esc(r.invoiceNumber) || '<span class="text-muted">-</span>'}</td>
        <td>${esc(r.invoiceDate)}</td>
        <td class="text-end">${formatINR(r.amount)}</td>
        <td>${esc(r.dueDate)}</td>
        <td>${link ? `<a href="${esc(link)}" target="_blank" rel="noopener"><i class="fa-solid fa-file-pdf"></i> PDF</a>` : '<span class="text-muted">-</span>'}</td>
        <td><span class="badge badge-soft ${isPaid(r) ? 'badge-soft-received' : 'badge-soft-pending'}">${esc(ROW_STATUS[r.status] || r.status || '-')}</span>
          ${isPaid(r) && r.receivedDate ? `<div class="text-muted" style="font-size:11px">${esc(r.receivedDate)}</div>` : ''}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-light border btn-sm" onclick="openRow(${r.row})"><i class="fa-solid fa-pen"></i> Update</button>
          ${ready ? `<button class="btn btn-primary btn-sm" onclick="sendToClient(${r.row})"><i class="fa-solid fa-envelope"></i> Send to client</button>` : ''}
        </td></tr>`;
    }).join('') + '</tbody>';
}

let editingRow = null;
function openRow(rowNo) {
  editingRow = inv.rows.find((r) => r.row === rowNo);
  $id('rowInfo').innerText = `${editingRow.client} · invoice date ${editingRow.invoiceDate} · ${formatINR(editingRow.amount)}`;
  $id('rwNumber').value = editingRow.invoiceNumber;
  $id('rwPdf').value = editingRow.pdfUrl;
  $id('rwStatus').value = Object.keys(ROW_STATUS).find((s) => s.toLowerCase() === editingRow.status.toLowerCase()) || 'NEW_ENTRY';
  $id('rwReceived').value = editingRow.receivedDateIso || localToday();
  toggleReceived();
  modal('rowModal').show();
}

function toggleReceived() {
  const paid = $id('rwStatus').value === 'Payment Received';
  $id('rwReceivedBox').classList.toggle('d-none', !paid);
  $id('rwReceived').required = paid;
}

async function saveRow(e) {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  const ok = await invPost({ action: 'update', update: { row: editingRow.row, client: editingRow.client, invoiceNumber: $id('rwNumber').value, pdfUrl: $id('rwPdf').value, status: $id('rwStatus').value, receivedDate: $id('rwReceived').value } }, 'Saved');
  btn.disabled = false;
  if (ok) { modal('rowModal').hide(); loadRows(); loadData(); }
}

async function sendToClient(rowNo) {
  const r = inv.rows.find((x) => x.row === rowNo);
  const c = inv.clients.find((x) => x.name.toLowerCase() === r.client.toLowerCase());
  if (!confirm(`Email invoice ${r.invoiceNumber} to ${r.client}${c ? ` (${c.emails})` : ''} with the PDF attached?`)) return;
  if (await invPost({ action: 'send', row: r.row, client: r.client }, 'Sent')) loadRows();
}

/* ---------- Request invoice ---------- */

function openRequest() {
  $id('rqType').innerHTML = inv.config.invoiceTypes.map((t) => `<option>${esc(t)}</option>`).join('');
  $id('rqClients').innerHTML = inv.clients.filter((c) => !c.onHold).map((c) => `<option value="${esc(c.name)}">`).join('');
  ['rqClient', 'rqPo', 'rqDesc', 'rqAmount'].forEach((id) => ($id(id).value = ''));
  $id('rqDate').value = localToday();
  $id('rqNow').checked = false;
  modal('requestModal').show();
}

async function submitRequest(e) {
  e.preventDefault();
  const client = inv.clients.find((c) => c.name.toLowerCase() === $id('rqClient').value.trim().toLowerCase());
  if (!client) return toast('Pick a client from the list (add new clients in the Clients tab)', false);
  const btn = e.submitter;
  btn.disabled = true;
  const ok = await invPost({ action: 'request', request: { invoiceType: $id('rqType').value, client: client.name, invoiceDate: $id('rqDate').value, poNumber: $id('rqPo').value, description: $id('rqDesc').value, amount: $id('rqAmount').value, sendNow: $id('rqNow').checked } }, 'Requested');
  btn.disabled = false;
  if (ok) { modal('requestModal').hide(); loadData(); if ($id('manage-tab').classList.contains('active')) loadRows(); else inv.rows = []; }
}

/* ---------- Clients ---------- */

function renderClients() {
  const list = inv.clients.filter((c) => matches('clientSearch', c.name, c.emails, c.contact, c.onHold ? 'on hold' : 'active'));
  $id('clientsTable').innerHTML = !inv.clients.length
    ? '<tr><td class="text-muted py-4 text-center">No clients yet. The admin can import them from the sheet (Automator Settings).</td></tr>'
    : !list.length ? '<tr><td class="text-muted py-4 text-center">No clients match your search.</td></tr>'
    : `<thead class="bg-light"><tr><th>Client</th><th>Emails</th><th>Contact</th><th>Status</th><th></th></tr></thead><tbody>`
      + list.map((c) => `<tr>
        <td class="fw-semibold" style="white-space:normal">${esc(c.name)}</td>
        <td style="white-space:normal;word-break:break-word">${esc(c.emails)}</td>
        <td>${esc(c.contact)}</td>
        <td>${c.onHold ? '<span class="badge badge-soft badge-soft-overdue">On hold</span>' : '<span class="badge badge-soft badge-soft-received">Active</span>'}</td>
        <td class="text-end"><button class="btn btn-light border btn-sm" onclick="openClient(${c.id})"><i class="fa-solid fa-pen"></i> Edit</button></td></tr>`).join('') + '</tbody>';
}

let editingClient = null;
function openClient(id) {
  editingClient = id ? inv.clients.find((c) => c.id === id) : null;
  $id('clientTitle').innerText = editingClient ? 'Edit client' : 'Add client';
  $id('clName').value = editingClient ? editingClient.name : '';
  $id('clName').disabled = Boolean(editingClient);
  $id('clEmails').value = editingClient ? editingClient.emails : '';
  $id('clContact').value = editingClient ? editingClient.contact : '';
  $id('clHold').checked = Boolean(editingClient && editingClient.onHold);
  modal('clientModal').show();
}

async function saveClient(e) {
  e.preventDefault();
  const ok = await invPost({ action: 'client', client: { id: editingClient?.id, name: $id('clName').value, emails: $id('clEmails').value, contact: $id('clContact').value, onHold: $id('clHold').checked } }, 'Client saved');
  if (ok) { modal('clientModal').hide(); renderClients(); }
}

/* ---------- Settings ---------- */

function fillConfig() {
  const c = inv.config;
  $id('cfgFinance').value = c.financeEmails;
  $id('cfgDays').value = c.requestDaysBefore;
  $id('cfgTime').value = c.requestTime;
  $id('cfgTypes').value = c.invoiceTypes.join(', ');
  $id('cfgIntervals').value = c.reminderIntervals.join(', ');
  TEMPLATES.forEach((t) => ($id(`cfg-${t.key}`).value = c[t.key] || ''));
}

async function saveConfig(e) {
  e.preventDefault();
  const config = {
    financeEmails: $id('cfgFinance').value, requestDaysBefore: Number($id('cfgDays').value), requestTime: $id('cfgTime').value,
    invoiceTypes: $id('cfgTypes').value, reminderIntervals: $id('cfgIntervals').value,
    ...Object.fromEntries(TEMPLATES.map((t) => [t.key, $id(`cfg-${t.key}`).value])),
  };
  if (await invPost({ action: 'config', config }, 'Settings saved')) fillConfig();
}

function previewTemplate(key) {
  const html = Object.entries(SAMPLE).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(esc(v)), $id(`cfg-${key}`).value || '<p>(empty template)</p>');
  $id('previewFrame').srcdoc = html; // sandboxed: no scripts run
  modal('previewModal').show();
}

async function saveScript(e) {
  e.preventDefault();
  if (await invPost({ action: 'script', script: $id('cfgScript').value }, 'Sheet link saved')) inv.rows = [];
}

async function importSheet() {
  if (!confirm('Copy the sheet\'s Config and ClientList tabs into the webapp? Settings here are replaced; clients already here are kept.')) return;
  if (await invPost({ action: 'import' }, 'Imported')) { renderClients(); fillConfig(); }
}

function copyCode() {
  navigator.clipboard.writeText($id('scriptCode').value).then(() => toast('Code copied'), () => toast('Select the code and copy it', false));
}
