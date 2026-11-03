// One PDF per invoice: an invoice page, then every page of each row's bill (in row order).
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { loadUpload, loadDrive } from './_bills.js';
import { driveToken } from './_lib.js';

const A4 = [595.28, 841.89];
const M = 40; // page margin
const GREY = rgb(0.6, 0.6, 0.6);
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// shortcut: standard PDF fonts only cover Latin-1, other characters print as "?"; embed a Unicode font if names need it.
const clean = (s) => String(s ?? '').replace(/[^\n\x20-\x7E\xA0-\xFF]/g, '?');
const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const showDate = (s) => `${s.slice(8, 10)} ${MONTH[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
export const invoiceNo = (inv) => (inv.kind === 'salary' ? 'SAL-' : 'RMB-') + String(inv.number).padStart(4, '0');

function wrap(font, size, text, width) {
  const lines = [];
  for (const para of clean(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

// loadBill(item) -> Buffer of the bill PDF, or throws with a reason shown on a notice page.
export async function buildInvoicePdf(inv, loadBill) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const emp = inv.employee || {};
  const er = inv.employer || {};
  const W = A4[0] - 2 * M;
  let page = doc.addPage(A4);
  let y = A4[1] - M;

  const text = (s, x, yy, { f = font, size = 10, color } = {}) => page.drawText(clean(s), { x, y: yy, size, font: f, color });
  const right = (s, xRight, yy, opts = {}) => text(s, xRight - (opts.f || font).widthOfTextAtSize(clean(s), opts.size || 10), yy, opts);
  const ensure = (h) => {
    if (y - h < M) {
      page = doc.addPage(A4);
      y = A4[1] - M;
    }
  };
  // Two side-by-side boxes of "label: value" lines.
  const boxes = (left, rightBox) => {
    const colW = W / 2;
    const rows = (b) => [[b.title, null, true], ...b.lines.filter(([, v]) => v).flatMap(([k, v]) =>
      wrap(font, 9, k ? `${k}: ${v}` : v, colW - 12).map((l) => [l]))];
    const L = rows(left), R = rows(rightBox);
    const h = Math.max(L.length, R.length) * 13 + 12;
    ensure(h);
    page.drawRectangle({ x: M, y: y - h, width: W, height: h, borderColor: GREY, borderWidth: 0.7 });
    page.drawLine({ start: { x: M + colW, y }, end: { x: M + colW, y: y - h }, color: GREY, thickness: 0.7 });
    [L, R].forEach((col, c) => col.forEach(([l, , isTitle], i) => text(l, M + 6 + c * colW, y - 15 - i * 13, { f: isTitle ? bold : font, size: isTitle ? 10 : 9 })));
    y -= h + 14;
  };

  text(`${inv.kind === 'salary' ? 'SALARY' : 'REIMBURSEMENT'} INVOICE`, M, y - 16, { f: bold, size: 18 });
  right(`Invoice No: ${invoiceNo(inv)}`, M + W, y - 8, { f: bold });
  right(`Date: ${showDate(inv.date)}`, M + W, y - 22);
  y -= 30;
  if (inv.status !== 'approved') {
    text(`${inv.status.toUpperCase()} - NOT YET APPROVED`, M, y - 6, { f: bold, color: rgb(0.7, 0.33, 0.04) });
    y -= 14;
  }
  y -= 12;

  boxes(
    { title: 'From', lines: [['', emp.name], ['', emp.address], ['Contact', emp.phone], ['Email', emp.email], ['PAN', emp.pan]] },
    { title: 'Bill To', lines: [['', er.companyName], ['GSTIN', er.gstin], ['PAN', er.pan]] },
  );

  // Items table
  const cNo = M + 6, cPart = M + 34, cAmt = M + W - 6, partW = W - 34 - 130;
  const rowLine = () => page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, color: GREY, thickness: 0.7 });
  const header = () => {
    ensure(22);
    rowLine();
    text('#', cNo, y - 14, { f: bold });
    text('Particulars', cPart, y - 14, { f: bold });
    right('Amount (Rs.)', cAmt, y - 14, { f: bold });
    y -= 20;
    rowLine();
  };
  header();
  inv.items.forEach((it, n) => {
    const lines = wrap(font, 10, it.particulars, partW);
    const h = lines.length * 13 + 8;
    if (y - h < M) {
      page = doc.addPage(A4);
      y = A4[1] - M;
      header();
    }
    text(String(n + 1), cNo, y - 14);
    lines.forEach((l, i) => text(l, cPart, y - 14 - i * 13));
    right(money(it.amount), cAmt, y - 14);
    y -= h;
    rowLine();
  });
  ensure(40);
  right('Subtotal', cAmt - 110, y - 14, { f: bold });
  right(money(inv.total), cAmt, y - 14);
  y -= 18;
  right('Grand Total', cAmt - 110, y - 14, { f: bold });
  right(`Rs. ${money(inv.total)}`, cAmt, y - 14, { f: bold });
  y -= 32;

  boxes(
    { title: 'Pay to (employee bank)', lines: [['Account No', emp.accountNumber], ['Bank', emp.bank], ['Branch', emp.branch], ['IFSC', emp.ifsc]] },
    { title: 'Employer bank', lines: [['Account No', er.accountNumber], ['Bank', er.bank], ['IFSC', er.ifsc], ['MICR', er.micr], ['Address', er.bankAddress]] },
  );

  const billed = inv.items.filter((it) => it.bill);
  if (billed.length) {
    ensure(16);
    text(`Bills for ${billed.length} item(s) are attached on the following pages.`, M, y - 10, { size: 9, color: GREY });
    y -= 22;
  }

  // Signature block
  ensure(90);
  const sigX = M + W - 200;
  const sig = String(emp.signature || '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
  if (sig) {
    try {
      const img = sig[1] === 'png' ? await doc.embedPng(Buffer.from(sig[2], 'base64')) : await doc.embedJpg(Buffer.from(sig[2], 'base64'));
      const s = img.scaleToFit(200, 55);
      page.drawImage(img, { x: sigX + 200 - s.width, y: y - 60, width: s.width, height: s.height });
    } catch {
      /* unreadable signature image: leave the space blank */
    }
  }
  page.drawLine({ start: { x: sigX, y: y - 66 }, end: { x: sigX + 200, y: y - 66 }, thickness: 0.8 });
  right(emp.name || '', sigX + 200, y - 80);
  if (inv.status === 'approved' && inv.approvedBy) {
    text('Approved by', M, y - 52, { f: bold, size: 9, color: GREY });
    text(inv.approvedBy, M, y - 66, { f: bold, size: 11 });
    if (inv.approvedOn) text(`on ${showDate(inv.approvedOn)}`, M, y - 80, { size: 9 });
  }

  // Attached bills
  for (const [n, it] of inv.items.entries()) {
    if (!it.bill) continue;
    let reason;
    try {
      const src = await PDFDocument.load(await loadBill(it), { ignoreEncryption: true });
      for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
      continue;
    } catch (e) {
      reason = e.message || 'The file could not be read';
    }
    page = doc.addPage(A4);
    text(`Bill for item ${n + 1}: ${it.particulars}`.slice(0, 90), M, A4[1] - M - 20, { f: bold, size: 13 });
    wrap(font, 11, `This bill could not be included. ${reason}`, W).forEach((l, i) => text(l, M, A4[1] - M - 46 - i * 15, { size: 11 }));
  }
  return Buffer.from(await doc.save());
}

// Loads an invoice (optionally limited to one user's own) and renders it with its bills.
export async function renderInvoicePdf(db, id, onlyUserId = null) {
  const [inv] = await db`select i.kind, i.number, to_char(i.invoice_date, 'YYYY-MM-DD') as date, i.items, i.total::float8 as total,
                                i.status, i.employer, i.employee, coalesce(nullif(u.name, ''), u.profile->>'name', u.email) as "userName",
                                coalesce(nullif(a.name, ''), nullif(a.profile->>'name', ''), a.email) as "approvedBy",
                                to_char(i.decided_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as "approvedOn"
                         from invoices i join users u on u.id = i.user_id left join users a on a.id = i.decided_by
                         where i.id = ${id} and (${onlyUserId === null} or i.user_id = ${onlyUserId})`;
  if (!inv) return null;
  const pdf = await buildInvoicePdf(inv, async (it) => {
    if (it.bill.drive) return loadDrive(it.bill.drive);
    const buf = await loadUpload(db, it.bill.upload);
    if (!buf) throw new Error('The uploaded file was deleted from storage (older than 3 months).');
    return buf;
  });
  const name = `${invoiceNo(inv)} - ${inv.userName} - ${inv.date}.pdf`.replace(/[\\/:*?"<>|]/g, '-');
  return { pdf, name, fileName: `${invoiceNo(inv)}.pdf` };
}

export const SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

// Saves the approved invoice PDF into the admin's Drive folder via their Apps Script web app.
// Never throws: the result (link or error) is stored on the invoice so the admin can retry.
export async function copyToDrive(db, id) {
  let url = '', error = '';
  try {
    const rows = await db`select key, value from settings where key in ('driveFolder', 'driveScript')`;
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.driveFolder || !SCRIPT_URL.test(cfg.driveScript || '')) throw new Error('Set the Drive folder and script link in Employer & Sheet');
    const out = await renderInvoicePdf(db, id);
    if (!out) throw new Error('Invoice not found');
    const res = await fetch(cfg.driveScript, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, // Apps Script reads the raw body; text/plain avoids a preflight-style rejection
      body: JSON.stringify({ secret: driveToken(), folderId: cfg.driveFolder, name: out.name, data: out.pdf.toString('base64') }),
      redirect: 'follow',
    });
    const reply = await res.json().catch(() => ({ error: `Drive script answered with HTTP ${res.status}. Check it is deployed with access "Anyone".` }));
    if (reply.error || !reply.url) throw new Error(reply.error || 'Drive script did not return a file link');
    url = reply.url;
  } catch (e) {
    error = String(e.message || e).slice(0, 300);
  }
  await db`update invoices set drive_url = ${url}, drive_error = ${error} where id = ${id}`;
  return { url, error };
}

