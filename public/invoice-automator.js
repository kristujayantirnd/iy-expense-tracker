// Client Invoice Automator on the Receivables page (Admin and Finance Admin only).
// Talks to /api/client-invoices; the sheet rows and Gmail are reached through the sheet's Apps Script.
let inv = { config: null, clients: [], drafts: [], rowDrafts: {}, rows: [], admin: false, manageTab: 'NEW_ENTRY' };

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
// Invoice Extracts' type column says "...reimbursement of the expenses incurred." for reimbursement invoices.
const isReimbRow = (r) => /reimburs/i.test(r.invoiceType || '');
// Same key as the server's rowDraftKey: sheet row + client + invoice date.
const rowDraftKey = (r) => `${r.row}|${r.client.toLowerCase()}|${r.invoiceDateIso || ''}`;
const rowDraftOf = (r) => inv.rowDrafts[rowDraftKey(r)];
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
    inv.drafts = data.drafts;
    inv.rowDrafts = data.rowDrafts || {};
    renderDrafts();
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
  Object.assign(inv, { config: data.config, clients: data.clients, drafts: data.drafts, rowDrafts: data.rowDrafts || {} });
  if (inv.rows.length) renderManage();
  renderClients();
  renderDrafts();
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

// Manage Invoices tabs, one per stage; any other sheet status counts as a new entry.
const MANAGE_TABS = [['NEW_ENTRY', 'New entry'], ['APPROVED', 'Approved'], ['REMINDER', 'Reminders'], ['PAID', 'Payment received']];
const tabOf = (r) => { const s = r.status.toUpperCase(); return s === 'PAYMENT RECEIVED' ? 'PAID' : ['APPROVED', 'REMINDER'].includes(s) ? s : 'NEW_ENTRY'; };
// A reimbursement invoice goes to the client only once its bills are in the PDF (added when it is approved).
const billsPending = (r) => isReimbRow(r) && r.billCount > 0 && !r.billsAttached;

function showManageTab(key) { inv.manageTab = key; renderManage(); }

// Amount Receivable column: the sheet's "to be received" figure, else worked out from the amount with GST (blank until that is in).
const receivableOf = (r) => (r.toReceive > 0 ? r.toReceive : r.withGst > 0 ? toBeReceived(r.withGst, r.amount, isReimbRow(r)) : 0);

function renderManage() {
  const found = inv.rows.filter((r) => matches('manageSearch', isReimbRow(r) ? 'reimbursement' : 'service', rowDraftOf(r) ? 'draft' : '', r.client, r.invoiceNumber, r.invoiceDate, r.dueDate, r.amount, receivableOf(r) || ''));
  $id('manageTabs').innerHTML = MANAGE_TABS.map(([key, label]) => {
    const n = found.filter((r) => tabOf(r) === key).length;
    const on = key === inv.manageTab;
    return `<li class="nav-item" role="presentation"><button type="button" role="tab" aria-selected="${on}" class="nav-link py-1 px-3 ${on ? 'active' : ''}" onclick="showManageTab('${key}')">${label} <span class="badge rounded-pill ${on ? 'bg-white text-primary' : 'bg-light text-dark border'} ms-1">${n}</span></button></li>`;
  }).join('');
  const paidTab = inv.manageTab === 'PAID';
  const list = found.filter((r) => tabOf(r) === inv.manageTab).slice().reverse(); // newest first
  if (!list.length) { $id('manageTable').innerHTML = `<tr><td class="text-muted py-4 text-center">${inv.rows.length ? 'No invoices here.' : 'No invoices to show.'}</td></tr>`; return; }
  $id('manageTable').innerHTML = `<thead class="bg-light"><tr><th>Client</th><th>Invoice Date</th><th class="text-end">Amount (w/o GST)</th><th class="text-end">Amount Receivable</th><th>${paidTab ? 'Received' : 'Due'}</th><th>PDF</th><th></th></tr></thead><tbody>`
    + list.map((r) => {
      const link = safeLink(r.pdfUrl);
      const reimb = isReimbRow(r);
      const ready = ['NEW_ENTRY', 'APPROVED'].includes(r.status.toUpperCase()) && r.invoiceNumber && link && r.withGst > 0 && !billsPending(r);
      const draft = rowDraftOf(r);
      return `<tr class="${reimb ? 'inv-reimb' : 'inv-service'}">
        <td style="white-space:normal;min-width:12rem">${esc(r.client)}
          <div class="d-flex align-items-center flex-wrap gap-2 mt-1">
            <span class="badge badge-soft ${reimb ? 'badge-type-reimb' : 'badge-type-service'}" style="font-size:10px">${reimb ? 'Reimbursement' : 'Service'}</span>
            ${r.invoiceNumber ? `<span class="inv-no">${esc(r.invoiceNumber)}</span>` : '<span class="inv-no text-muted fst-italic">No invoice no. yet</span>'}
            ${draft ? `<span class="badge badge-soft badge-soft-upcoming" style="font-size:10px" title="Draft by ${esc(draft.by)} on ${esc(draft.on)}, not yet in the sheet"><i class="fa-solid fa-pen-ruler me-1"></i>Draft</span>` : ''}
          </div></td>
        <td>${esc(r.invoiceDate)}</td>
        <td class="text-end">${formatINR(r.amount)}</td>
        <td class="text-end" title="${isReimbRow(r) ? 'Amount with GST (reimbursement, no TDS)' : 'Amount with GST − 10% TDS on the amount w/o GST'}">${receivableOf(r) ? formatINR(receivableOf(r)) : '<span class="text-muted" title="Add the amount with GST to see this">-</span>'}</td>
        <td>${esc(paidTab ? r.receivedDate || '-' : r.dueDate)}</td>
        <td>${link ? `<button type="button" class="btn btn-light border btn-sm" onclick="previewPdf(${r.row})"><i class="fa-solid fa-file-pdf"></i> PDF</button>` : '<span class="text-muted">-</span>'}
          ${reimb && r.billCount ? `<div class="inv-no mt-1 ${r.billsAttached ? 'text-success' : 'text-muted'}"><i class="fa-solid fa-paperclip me-1"></i>${r.billCount} bill${r.billCount > 1 ? 's' : ''}${r.billsAttached ? ' included' : ' (added on approval)'}</div>` : ''}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-light border btn-sm" onclick="openRow(${r.row})"><i class="fa-solid fa-pen"></i> Update</button>
          ${ready ? `<button class="btn btn-primary btn-sm" onclick="sendToClient(${r.row})"><i class="fa-solid fa-envelope"></i> Send to client</button>` : ''}
          ${r.status.toUpperCase() === 'NEW_ENTRY' ? `<button class="btn btn-outline-danger btn-sm" onclick="deleteRow(${r.row})" title="Delete this new entry" aria-label="Delete invoice for ${esc(r.client)}"><i class="fa-solid fa-trash"></i></button>` : ''}
        </td></tr>`;
    }).join('') + '</tbody>';
}

// Shows an invoice PDF in a dialog (dashboard tabs and Manage Invoices, every role that sees the page).
// Drive files use Drive's embeddable viewer, so the viewer must have access to the file.
function openPdf(url, title) {
  const link = safeLink(url);
  if (!link) return;
  const id = (link.match(/\/d\/([-\w]{25,})/) || link.match(/[?&]id=([-\w]{25,})/) || [])[1];
  $id('pdfTitle').innerText = title;
  $id('pdfFrame').src = id ? `https://drive.google.com/file/d/${id}/preview` : link;
  $id('pdfOpen').href = link;
  modal('pdfModal').show();
}
$id('pdfModal').addEventListener('hidden.bs.modal', () => { $id('pdfFrame').src = 'about:blank'; }); // stop loading once closed

function previewPdf(rowNo) {
  const r = inv.rows.find((x) => x.row === rowNo);
  openPdf(r.pdfUrl, `Invoice ${r.invoiceNumber || ''} · ${r.client}`);
}

let editingRow = null;
function openRow(rowNo) {
  editingRow = inv.rows.find((r) => r.row === rowNo);
  const d = rowDraftOf(editingRow); // a saved draft takes the place of the sheet's values
  $id('rowInfo').innerText = `${editingRow.client} · invoice date ${editingRow.invoiceDate} · ${formatINR(editingRow.amount)}`;
  $id('rwDraftNote').classList.toggle('d-none', !d);
  if (d) $id('rwDraftBy').innerText = `${d.by} on ${d.on}`;
  $id('rwNumber').value = d ? d.invoiceNumber : editingRow.invoiceNumber;
  $id('rwPdf').value = d ? d.pdfUrl : editingRow.pdfUrl;
  $id('rwGst').value = (d ? d.withGst : editingRow.withGst) || '';
  $id('rwStatus').value = d ? d.status : Object.keys(ROW_STATUS).find((s) => s.toLowerCase() === editingRow.status.toLowerCase()) || 'NEW_ENTRY';
  $id('rwReceived').value = (d && d.receivedDate) || editingRow.receivedDateIso || localToday();
  toggleReceived();
  rowReadiness();
  rowBills();
  modal('rowModal').show();
}

// Approved / Emailed need the invoice number, the PDF link and the amount with GST (checked again on the server).
const NEEDS_DETAILS = ['APPROVED', 'REMINDER'];
// Preview only; the sheet script saves the same figure from the row's own amount (keep in step with iyToBeReceived_).
// Reimbursement invoices carry no TDS: the amount to be received is the amount with GST.
const toBeReceived = (withGst, withoutGst, reimb) => Math.round((reimb ? withGst : withGst - 0.1 * withoutGst) * 100) / 100;
const DRIVE_LINK = /^https:\/\/(drive|docs)\.google\.com\/.*[-\w]{25,}/;
function rowMissing() {
  return [
    !$id('rwNumber').value.trim() && 'invoice number',
    !DRIVE_LINK.test($id('rwPdf').value.trim()) && 'invoice PDF Google Drive link',
    !(Number($id('rwGst').value) > 0) && 'amount with GST',
  ].filter(Boolean);
}
function rowReadiness() {
  const gst = Number($id('rwGst').value);
  const reimb = isReimbRow(editingRow);
  $id('rwFormula').innerHTML = reimb ? '= amount with GST (reimbursement invoice, no TDS)'
    : `= amount with GST − 10% TDS on <span id="rwBase">${formatINR(editingRow.amount)}</span> (amount w/o GST)`;
  const calc = gst > 0 ? toBeReceived(gst, editingRow.amount, reimb) : 0;
  // Opened unchanged: show what the sheet holds, and flag it if saving would change it.
  const sheet = gst > 0 && gst === editingRow.withGst ? editingRow.toReceive : 0;
  $id('rwToReceive').innerText = gst > 0 ? formatINR(calc) : '-';
  $id('rwSheetNote').innerText = sheet && Math.abs(sheet - calc) > 0.005 ? ` The sheet now has ${formatINR(sheet)}; saving replaces it.` : '';
  const missing = rowMissing();
  const sel = $id('rwStatus');
  [...sel.options].forEach((o) => { if (NEEDS_DETAILS.includes(o.value)) o.disabled = missing.length > 0 && o.value !== sel.value; });
  $id('rwReadyHint').classList.toggle('d-none', !missing.length);
  $id('rwReadyHint').innerText = `To choose Approved or Emailed, add the ${missing.join(', ')}.`;
  $id('rwReadyHint').classList.toggle('text-danger', missing.length > 0 && NEEDS_DETAILS.includes(sel.value));
}

// Approving a reimbursement invoice adds its request's bills to the PDF from page 2 (done on Save to sheet).
function rowBills() {
  const r = editingRow;
  const show = isReimbRow(r) && $id('rwStatus').value === 'APPROVED';
  $id('rwBillsBox').classList.toggle('d-none', !show);
  if (!show) return;
  const n = r.billCount || 0;
  const already = r.billsAttached && $id('rwPdf').value.trim() === r.pdfUrl;
  $id('rwBills').disabled = !n;
  $id('rwBills').checked = n > 0 && !already;
  $id('rwBillsLabel').innerText = !n ? 'No bills were found for this reimbursement request, so the PDF stays as it is.'
    : already ? `The ${n} bill${n > 1 ? 's are' : ' is'} already in the invoice PDF. Tick to rebuild it from the original invoice with the bills.`
    : `Add the request's ${n} bill${n > 1 ? 's' : ''} to the invoice PDF from page 2 (a new PDF is saved next to the invoice in Drive).`;
}

function toggleReceived() {
  const paid = $id('rwStatus').value === 'Payment Received';
  $id('rwReceivedBox').classList.toggle('d-none', !paid);
  $id('rwReceived').required = paid;
}

async function saveRow(e) {
  e.preventDefault();
  const missing = rowMissing();
  if (NEEDS_DETAILS.includes($id('rwStatus').value) && missing.length) return toast(`Add the ${missing.join(', ')} before choosing this status`, false);
  const btn = e.submitter;
  btn.disabled = true;
  const attach = !$id('rwBillsBox').classList.contains('d-none') && $id('rwBills').checked;
  if (attach) btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Adding the bills…';
  const ok = await invPost({ action: 'update', update: { ...rowForm(), attachBills: attach, rebuildBills: attach && editingRow.billsAttached } }, 'Saved');
  btn.innerText = 'Save to sheet';
  btn.disabled = false;
  if (ok) { modal('rowModal').hide(); loadRows(); loadData(); }
}

const rowForm = () => ({ row: editingRow.row, client: editingRow.client, invoiceDateIso: editingRow.invoiceDateIso || '', invoiceNumber: $id('rwNumber').value,
  pdfUrl: $id('rwPdf').value, withGst: $id('rwGst').value, status: $id('rwStatus').value, receivedDate: $id('rwReceived').value });

// Keeps what is filled in so far in the app only; the sheet row is untouched until Save to sheet.
async function saveRowDraft(btn) {
  btn.disabled = true;
  const ok = await invPost({ action: 'rowDraft', update: rowForm() }, 'Draft saved');
  btn.disabled = false;
  if (ok) { modal('rowModal').hide(); renderManage(); }
}

async function discardRowDraft() {
  if (!confirm('Discard this draft? The form goes back to what the sheet has.')) return;
  if (await invPost({ action: 'deleteRowDraft', update: rowForm() }, 'Draft discarded')) { renderManage(); openRow(editingRow.row); }
}

// New entries only: removes the row from the sheet (and its request, if the Finance Team hasn't been emailed yet).
async function deleteRow(rowNo) {
  const r = inv.rows.find((x) => x.row === rowNo);
  if (!confirm(`Delete the new entry for ${r.client} (invoice date ${r.invoiceDate}, ${formatINR(r.amount)})?\n\nThe row is removed from the sheet's Invoice Extracts tab. This can't be undone.`)) return;
  if (await invPost({ action: 'delete', update: { row: r.row, client: r.client, invoiceDateIso: r.invoiceDateIso || '' } }, 'Deleted')) loadRows();
}

async function sendToClient(rowNo) {
  const r = inv.rows.find((x) => x.row === rowNo);
  const c = inv.clients.find((x) => x.name.toLowerCase() === r.client.toLowerCase());
  if (!confirm(`Email invoice ${r.invoiceNumber} to ${r.client}${c ? ` (${c.emails})` : ''} with the PDF attached?`)) return;
  if (await invPost({ action: 'send', row: r.row, client: r.client }, 'Sent')) loadRows();
}

/* ---------- Request invoice ---------- */
// Reimbursement types are built row by row (one bill per row) and can be kept pending until every bill is in.

const isReimb = (type) => /reimburs/i.test(type || '');
let rq = { draftId: null, items: [] };
const blankRow = () => ({ date: localToday(), particulars: '', amount: '', link: '' });

function openRequest(draftId) {
  const draft = draftId ? inv.drafts.find((d) => d.id === draftId) : null;
  $id('rqType').innerHTML = inv.config.invoiceTypes.map((t) => `<option>${esc(t)}</option>`).join('');
  ['rqClient', 'rqPo', 'rqDesc', 'rqAmount', 'rqAttach'].forEach((id) => ($id(id).value = ''));
  $id('rqDate').value = localToday();
  $id('rqNow').checked = false;
  rq = { draftId: null, items: [blankRow()] };
  if (draft) {
    $id('rqType').value = draft.invoiceType;
    $id('rqClient').value = draft.client;
    loadDraft(draft);
  } else showDraftState();
  requestTypeChanged();
  modal('requestModal').show();
}

function loadDraft(draft) {
  rq = { draftId: draft.id, items: draft.items.map((it) => ({ ...it })) };
  $id('rqPo').value = draft.poNumber;
  showDraftState(`Continuing the pending request for ${draft.client} (saved ${draft.updatedOn}). Add rows, then save or submit.`);
}

function showDraftState(note) {
  $id('rqDraftNote').innerText = note || '';
  $id('rqDraftNote').classList.toggle('d-none', !note);
  $id('rqClient').disabled = Boolean(rq.draftId); // a pending request belongs to its client
  $id('rqDelete').classList.toggle('d-none', !rq.draftId);
}

function requestTypeChanged() {
  const reimb = isReimb($id('rqType').value);
  $id('rqSingle').classList.toggle('d-none', reimb);
  $id('rqRows').classList.toggle('d-none', !reimb);
  $id('rqSaveDraft').classList.toggle('d-none', !reimb);
  $id('rqDesc').required = !reimb;
  $id('rqAmount').required = !reimb;
  if (reimb) { requestClientChanged(); renderRequestRows(); }
}

// Client picker: type to filter (any part of the name), arrows + Enter, or click. Clients on hold are left out.
let clientShown = [], clientActive = -1;
function openClientList(all) {
  if ($id('rqClient').disabled) return;
  const q = all ? '' : $id('rqClient').value.trim().toLowerCase();
  clientShown = inv.clients.filter((c) => !c.onHold && (!q || c.name.toLowerCase().includes(q)));
  clientActive = clientShown.length ? 0 : -1;
  renderClientList();
}
function renderClientList() {
  const list = $id('rqClients');
  list.innerHTML = clientShown.length
    ? clientShown.map((c, i) => `<li id="client-opt-${c.id}" role="option" aria-selected="${i === clientActive}" onmousedown="event.preventDefault(); chooseClient(${c.id})">${esc(c.name)}</li>`).join('')
    : '<li class="empty">No matching client</li>';
  list.classList.remove('d-none');
  $id('rqClient').setAttribute('aria-expanded', 'true');
  $id('rqClient').setAttribute('aria-activedescendant', clientActive >= 0 ? `client-opt-${clientShown[clientActive].id}` : '');
  const on = list.querySelector('[aria-selected="true"]');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
function closeClientList() {
  $id('rqClients').classList.add('d-none');
  $id('rqClient').setAttribute('aria-expanded', 'false');
  requestClientChanged(); // a typed full name also continues a pending request
}
function toggleClientList() {
  if ($id('rqClients').classList.contains('d-none')) { $id('rqClient').focus(); openClientList(true); } else closeClientList();
}
function clientListKey(e) {
  const open = !$id('rqClients').classList.contains('d-none');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) return openClientList(true);
    if (!clientShown.length) return;
    clientActive = (clientActive + (e.key === 'ArrowDown' ? 1 : -1) + clientShown.length) % clientShown.length;
    renderClientList();
  } else if (e.key === 'Enter') {
    e.preventDefault(); // don't submit the form
    if (open && clientActive >= 0) chooseClient(clientShown[clientActive].id);
  } else if (e.key === 'Escape' && open) {
    e.preventDefault(); e.stopPropagation(); // close the list, not the dialog
    closeClientList();
  }
}
function chooseClient(id) {
  $id('rqClient').value = inv.clients.find((c) => c.id === id).name;
  closeClientList();
  requestClientChanged();
}

// Picking a client with a pending reimbursement request continues that request.
function requestClientChanged() {
  if (rq.draftId || !isReimb($id('rqType').value)) return;
  const draft = inv.drafts.find((d) => d.client.toLowerCase() === $id('rqClient').value.trim().toLowerCase());
  if (draft) { $id('rqType').value = draft.invoiceType; loadDraft(draft); renderRequestRows(); }
}

function renderRequestRows() {
  $id('rqItems').innerHTML = `<thead><tr><th style="width:2rem">#</th><th style="width:6.5rem">Added</th><th>Particulars</th><th style="width:9rem">Amount (₹)</th><th>Bill (Google Drive link, optional)</th><th style="width:2rem"></th></tr></thead><tbody>`
    + rq.items.map((it, n) => `<tr>
      <td class="text-muted">${n + 1}</td>
      <td class="text-muted small">${esc(it.date.split('-').reverse().join('/'))}</td>
      <td><input class="form-control form-control-sm" required maxlength="300" aria-label="Particulars, row ${n + 1}" value="${esc(it.particulars)}" oninput="rq.items[${n}].particulars = this.value"></td>
      <td><input class="form-control form-control-sm text-end" required type="number" min="0.01" step="0.01" aria-label="Amount, row ${n + 1}" value="${esc(it.amount)}" oninput="rq.items[${n}].amount = this.value; requestTotal()"></td>
      <td><input class="form-control form-control-sm" type="url" maxlength="500" placeholder="https://drive.google.com/file/d/…" aria-label="Bill link, row ${n + 1}" value="${esc(it.link)}" oninput="rq.items[${n}].link = this.value"></td>
      <td>${rq.items.length > 1 ? `<button type="button" class="btn btn-light border btn-sm" onclick="rq.items.splice(${n}, 1); renderRequestRows()" aria-label="Remove row ${n + 1}"><i class="fa-solid fa-trash"></i></button>` : ''}</td>
    </tr>`).join('') + '</tbody>';
  requestTotal();
}

function addRequestRow() {
  rq.items.push(blankRow());
  renderRequestRows();
  $id('rqItems').querySelector('tbody tr:last-child input').focus();
}

function requestTotal() {
  $id('rqTotal').innerText = formatINR(rq.items.reduce((s, it) => s + (Number(it.amount) || 0), 0));
}

function requestBody() {
  const client = inv.clients.find((c) => c.name.toLowerCase() === $id('rqClient').value.trim().toLowerCase());
  if (!client) { toast('Pick a client from the list (add new clients in the Clients tab)', false); return null; }
  const base = { invoiceType: $id('rqType').value, client: client.name, invoiceDate: $id('rqDate').value, poNumber: $id('rqPo').value, sendNow: $id('rqNow').checked };
  if (!isReimb(base.invoiceType)) return { ...base, description: $id('rqDesc').value, amount: $id('rqAmount').value, attachmentUrl: $id('rqAttach').value };
  return { ...base, draftId: rq.draftId, items: rq.items.map((it) => ({ ...it, amount: Number(it.amount) })) };
}

function requestDone() {
  modal('requestModal').hide();
  loadData();
  if ($id('manage-tab').classList.contains('active')) loadRows(); else inv.rows = [];
}

async function submitRequest(e) {
  e.preventDefault();
  const request = requestBody();
  if (!request) return;
  const btn = e.submitter;
  btn.disabled = true;
  const ok = await invPost({ action: 'request', request }, 'Requested');
  btn.disabled = false;
  if (ok) requestDone();
}

async function saveDraftRequest() {
  if (!$id('requestModal').querySelector('form').reportValidity()) return;
  const request = requestBody();
  if (request && await invPost({ action: 'draft', request }, 'Saved as pending')) modal('requestModal').hide();
}

async function deleteDraft() {
  if (!confirm('Delete this pending request and all its rows?')) return;
  if (await invPost({ action: 'deleteDraft', id: rq.draftId }, 'Deleted')) modal('requestModal').hide();
}

function renderDrafts() {
  const box = $id('draftsBox');
  box.classList.toggle('d-none', !inv.drafts.length);
  box.innerHTML = !inv.drafts.length ? '' : `<div class="fw-semibold small mb-1"><i class="fa-solid fa-hourglass-half"></i> Pending reimbursement requests (not yet sent to the Finance Team)</div>
    <table class="table align-middle mb-0 small"><tbody>${inv.drafts.map((d) => `<tr>
      <td style="white-space:normal">${esc(d.client)}</td><td>${d.items.length} row(s)</td>
      <td class="text-end">${formatINR(d.items.reduce((s, it) => s + it.amount, 0))}</td><td class="text-muted">Saved ${esc(d.updatedOn)}</td>
      <td class="text-end"><button class="btn btn-primary btn-sm" onclick="openRequest(${d.id})"><i class="fa-solid fa-pen"></i> Continue</button></td></tr>`).join('')}</tbody></table>`;
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
