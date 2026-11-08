// Checks the password and session logic. Usage: npm test
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, makeSession, readSession, buildRegister, registerCsv, sheetToken, ptAccess } from '../api/_lib.js';

const h = hashPassword('correct horse');
assert.equal(verifyPassword('correct horse', h), true);
assert.equal(verifyPassword('wrong', h), false);
assert.equal(verifyPassword('x', 'garbage'), false);

const s = makeSession(42, 'secret', 1000);
assert.equal(readSession(s, 'secret', 1000), 42);
assert.equal(readSession(s, 'other-secret', 1000), null, 'wrong secret rejected');
assert.equal(readSession(s.replace(/^42/, '43'), 'secret', 1000), null, 'tampered user rejected');
assert.equal(readSession(s, 'secret', 1000 + 8 * 864e5), null, 'expired rejected');
assert.equal(readSession('', 'secret'), null);
assert.equal(readSession(s, undefined), null, 'missing secret rejected');

// Project Tracker access: an owner link or the pt_admin extra role.
assert.equal(ptAccess(null, []), false);
assert.equal(ptAccess({}, []), true);
assert.equal(ptAccess(null, ['pt_admin']), true);
assert.equal(ptAccess(null, null), false);

// Payout = salary - 10% TDS + reimbursements, per employee per month.
const reg = buildRegister([
  { userId: 1, name: 'Asha', email: 'a@x', kind: 'salary', date: '2026-11-01', total: 50000 },
  { userId: 1, name: 'Asha', email: 'a@x', kind: 'reimbursement', date: '2026-11-10', total: 1200.5 },
  { userId: 1, name: 'Asha', email: 'a@x', kind: 'reimbursement', date: '2026-11-20', total: 300 },
  { userId: 1, name: 'Asha', email: 'a@x', kind: 'reimbursement', date: '2026-10-31', total: 99 },
  { userId: 2, name: 'Ben', email: 'b@x', kind: 'salary', date: '2026-11-05', total: 33333.33 },
]);
assert.deepEqual(reg.map((r) => [r.month, r.name, r.salary, r.tds, r.netSalary, r.reimbursement, r.payout]), [
  ['2026-10', 'Asha', 0, 0, 0, 99, 99],
  ['2026-11', 'Asha', 50000, 5000, 45000, 1500.5, 46500.5],
  ['2026-11', 'Ben', 33333.33, 3333.33, 30000, 0, 30000],
]);
const csv = registerCsv([{ month: '2026-11', name: '=HYPERLINK("x")', email: 'a@x', salary: 1, tds: 0.1, netSalary: 0.9, reimbursement: 0, payout: 0.9 }]);
assert.equal(csv.split('\n')[1], `"2026-11","'=HYPERLINK(""x"")","a@x",1,0.1,0.9,0,0.9`, 'csv escapes quotes and formulas');
assert.equal(sheetToken('s'), sheetToken('s'));
assert.notEqual(sheetToken('s'), sheetToken('t'));

// Client Invoice Automator: email lists and settings as imported from the sheet's Config tab.
{
  const { emailList, cleanConfig, cleanItems, readyMissing } = await import('../api/client-invoices.js');
  assert.equal(emailList('a@x.com; b@y.in,  c@z.org ;'), 'a@x.com; b@y.in; c@z.org');
  assert.equal(emailList('a@x.com; a@x.com'), 'a@x.com', 'duplicates dropped');
  assert.throws(() => emailList('a@x.com; not-an-email'), /not-an-email/);
  assert.throws(() => emailList(''), /at least one/);
  assert.equal(emailList('', false), '');
  const cfg = cleanConfig({ financeEmails: 'f@a.com; g@b.com', requestDaysBefore: 0, requestTime: '10:00', invoiceTypes: 'Service, Reimbursed Expense', reminderIntervals: '15,30,40,43' });
  assert.deepEqual(cfg.invoiceTypes, ['Service', 'Reimbursed Expense']);
  assert.deepEqual(cfg.reminderIntervals, [15, 30, 40, 43]);
  assert.deepEqual(cleanConfig({ ...cfg, reminderIntervals: '' }).reminderIntervals, [], 'no reminders allowed');
  assert.throws(() => cleanConfig({ ...cfg, reminderIntervals: '30,15' }), /increasing/);
  assert.throws(() => cleanConfig({ ...cfg, requestTime: '25:00' }), /time/);
  assert.throws(() => cleanConfig({ ...cfg, invoiceTypes: ' , ' }), /invoice type/);
  // Reimbursement request rows: particulars + amount required, bill link optional (Drive only), future dates clamp to today.
  const items = cleanItems([{ particulars: ' Flight ', amount: '52814', date: '2026-11-01' }, { particulars: 'Cab', amount: 702.005, date: '2099-01-01', link: '' }], '2026-11-05');
  assert.deepEqual(items, [{ date: '2026-11-01', particulars: 'Flight', amount: 52814, link: '' }, { date: '2026-11-05', particulars: 'Cab', amount: 702.01, link: '' }]);
  assert.throws(() => cleanItems([]), /at least one row/);
  // Approved / Emailed need all three details.
  assert.deepEqual(readyMissing({ invoiceNumber: 'VD/1', pdfUrl: 'https://drive.google.com/file/d/x', withGst: 590000 }), []);
  assert.deepEqual(readyMissing({ invoiceNumber: '', pdfUrl: '', withGst: null }), ['invoice number', 'invoice PDF Google Drive link', 'amount with GST']);
  assert.deepEqual(readyMissing({ invoiceNumber: 'VD/1', pdfUrl: 'x', withGst: 0 }), ['amount with GST']);
  assert.throws(() => cleanItems([{ particulars: 'Cab', amount: 0 }]), /Row 1/);
  assert.throws(() => cleanItems([{ particulars: 'Cab', amount: 5, link: 'https://example.com/bill.pdf' }]), /Row 1: the bill/);
  assert.equal(cleanItems([{ particulars: 'Cab', amount: 5, link: 'https://drive.google.com/file/d/1xGc7Rbrmr4ODSXTfp1rng-acTagO72I1/view' }])[0].link.length > 0, true);
}

// The Apps Script's date parsing and template filling (run here with a fake time zone).
{
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const ctx = { SpreadsheetApp: {}, Utilities: {} };
  vm.runInNewContext(readFileSync(new URL('../public/apps-script/InvoiceAutomator.gs', import.meta.url), 'utf8') + '\nthis.f = { iyDate_, iyFill_, iyFileId_, iyToBeReceived_ };', ctx);
  const { iyDate_, iyFill_, iyFileId_, iyToBeReceived_ } = ctx.f;
  // Amt(ToBeReceived) as in the sheet's existing rows (service with GST, reimbursement without).
  assert.equal(iyToBeReceived_(413000, 350000), 378000);
  assert.equal(iyToBeReceived_(1911600, 1620000), 1749600);
  assert.equal(iyToBeReceived_(41047, 41047), 36942.3);
  const page = readFileSync(new URL('../public/invoice-automator.js', import.meta.url), 'utf8');
  const toBeReceived = vm.runInNewContext(page.match(/const toBeReceived = [^;]+;/)[0].replace('const toBeReceived =', '') );
  assert.equal(toBeReceived(413000, 350000), 378000, 'the dialog preview uses the same formula');
  assert.deepEqual([iyDate_('2026-11-05').getFullYear(), iyDate_('2026-11-05').getMonth(), iyDate_('2026-11-05').getDate()], [2026, 10, 5]);
  assert.equal(iyDate_('06/04/2026').getMonth(), 3, 'dd/mm/yyyy is day first');
  assert.equal(iyDate_('soon'), null);
  assert.equal(iyFill_('Hi {{ContactPoint}}, {{Invoice number}} {{Invoice number}}', { ContactPoint: 'A&B', 'Invoice number': 'VD/1' }), 'Hi A&amp;B, VD/1 VD/1');
  assert.equal(iyFill_('<td>{{ItemDescription}}</td>', { ItemDescription: 'Flight - ₹52,814.00\nCab - ₹702.00' }), '<td>Flight - ₹52,814.00<br>Cab - ₹702.00</td>', 'one line per row');
  assert.equal(iyFileId_('https://drive.google.com/file/d/1xGc7Rbrmr4ODSXTfp1rng-acTagO72I1/view?usp=drivesdk'), '1xGc7Rbrmr4ODSXTfp1rng-acTagO72I1');
}

// Approved reimbursement invoices: the invoice first, then each bill (PDF pages or an image page), a note page for unreadable ones.
{
  const { PDFDocument } = await import('pdf-lib');
  const { mergeBills } = await import('../api/client-invoices.js');
  const pdf = async (pages) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage(); return Buffer.from(await d.save()).toString('base64'); };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const m = await mergeBills({ data: await pdf(1) }, [{ type: 'application/pdf', data: await pdf(2) }, { type: 'image/png', data: png }, { name: 'Bill ₹', error: 'Cannot open' }]);
  assert.equal((await PDFDocument.load(m.pdf)).getPageCount(), 5);
  assert.deepEqual([m.added, m.skipped], [2, 1]);
  await assert.rejects(mergeBills({ data: 'bm90' }, []), /invoice PDF/);
}

console.log('selfcheck ok');
