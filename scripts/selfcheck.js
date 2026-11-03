// Checks the password and session logic. Usage: npm test
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, makeSession, readSession, buildRegister, registerCsv, sheetToken } from '../api/_lib.js';

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
console.log('selfcheck ok');
