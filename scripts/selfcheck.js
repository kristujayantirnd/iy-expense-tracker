// Checks the password and session logic. Usage: npm test
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, makeSession, readSession } from '../api/_lib.js';

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
console.log('selfcheck ok');
