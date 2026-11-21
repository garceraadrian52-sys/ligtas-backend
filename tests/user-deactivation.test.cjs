const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const express = require('express');
const initial = {
  resident: { role: 'RESIDENT', name: 'Resident', disabled: false, householdId: 'keep', displayId: 'ACC-00003' },
  official: { role: 'BARANGAY_OFFICIAL', disabled: false, barangayId: 'barangay_santol' },
  admin: { role: 'LGU_ADMIN', disabled: false },
  super: { role: 'SUPER_ADMIN', disabled: false },
};
let accounts, authAccounts, versions, writes, authCalls, revoked, audits;
let failAuth, failFirestore, failAudit, failRevoke, failRecovery, failRecoveryRead, staleEdit, ambiguousCommit;
const version = id => ({ value: versions[id], isEqual(other) { return other?.value === this.value; } });
const db = {
  doc(path) {
    const id = path.split('/')[1];
    return { id, async get() { if (failRecoveryRead && authCalls.length) throw Error('Read unavailable'); return { id, exists: !!accounts[id], updateTime: version(id), data: () => ({ ...accounts[id] }) }; } };
  },
  collection(name) {
    assert.equal(name, 'users');
    return { where: () => ({ get: async () => ({ docs: Object.keys(accounts).map(id => ({ id, data: () => accounts[id] })) }) }) };
  },
  async runTransaction(callback) {
    const pending = [], pendingAudits = [];
    const result = await callback({
      async get(ref) { if (staleEdit) { versions[ref.id]++; staleEdit = false; } return ref.get(); },
      update(ref, value) { pending.push({ id: ref.id, value }); },
      audit(value) { if (failAudit) throw Error('Audit unavailable'); pendingAudits.push(value); },
    });
    if (failFirestore) throw Error('Firestore unavailable');
    pending.forEach(({ id, value }) => { writes.push({ id, value }); Object.assign(accounts[id], value); versions[id]++; });
    audits.push(...pendingAudits);
    if (ambiguousCommit) throw Error('Commit acknowledgement unavailable');
    return result;
  },
};
const auth = {
  async getUser(id) { if (!authAccounts[id]) throw Object.assign(Error('No Auth account'), { code: 'auth/user-not-found' }); return { uid: id, ...authAccounts[id] }; },
  async updateUser(id, value) { if (failAuth || (failRecovery && authCalls.length)) throw Error('Auth unavailable'); authCalls.push({ id, value }); Object.assign(authAccounts[id], value); },
  async revokeRefreshTokens(id) { if (failRevoke) throw Error('Revoke unavailable'); revoked.push(id); },
  async deleteUser() { throw Error('Deletion must not be called'); },
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth } };
require.cache[require.resolve('../dist/middleware/auth')] = { exports: { requireAuth(req, res, next) {
  if (!req.get('x-role')) return res.status(401).json({ error: 'Authentication required' });
  req.user = { uid: 'caller', role: req.get('x-role') }; next();
} } };
require.cache[require.resolve('../dist/services/auditLog')] = { exports: {
  logAction: async (...args) => audits.push(args),
  logActionInTransaction: (transaction, audit) => transaction.audit(audit),
} };
const app = express(); app.use(express.json()); app.use('/users', require('../dist/routes/users').default);
let server, base;
before(async () => { server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = 'http://127.0.0.1:' + server.address().port + '/users'; });
after(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => {
  accounts = structuredClone(initial); authAccounts = structuredClone(initial); versions = Object.fromEntries(Object.keys(initial).map(id => [id, 1]));
  writes = []; authCalls = []; revoked = []; audits = [];
  failAuth = failFirestore = failAudit = failRevoke = failRecovery = failRecoveryRead = staleEdit = ambiguousCommit = false;
});
const patch = (id, role = 'SUPER_ADMIN', body = { disabled: true }) => fetch(base + '/' + id + '/status', {
  method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify(body),
});
const disabled = id => { accounts[id].disabled = authAccounts[id].disabled = true; };

test('LGU and Super Admin deactivate residents without changing roles or related records', async () => {
  for (const role of ['LGU_ADMIN', 'SUPER_ADMIN']) assert.equal((await patch('resident', role)).status, 200);
  assert.equal(authCalls.length, 2); assert.equal(revoked.length, 2); assert.equal(writes.length, 2);
  assert.equal(accounts.resident.role, 'RESIDENT'); assert.equal(accounts.resident.householdId, 'keep'); assert.equal(audits.length, 2);
});
test('status-only payloads reject role escalation, profile edits and non-boolean values', async () => {
  for (const body of [{ disabled: true, role: 'SUPER_ADMIN' }, { disabled: true, name: 'changed' }, { disabled: 'false' }, {}, []]) assert.equal((await patch('resident', 'SUPER_ADMIN', body)).status, 400);
  assert.equal(writes.length, 0); assert.equal(authCalls.length, 0);
});
test('only Super Admin can reactivate residents, BOs and municipal/system accounts', async () => {
  for (const id of Object.keys(initial)) {
    disabled(id); const before = { ...accounts[id] };
    const response = await patch(id, 'SUPER_ADMIN', { disabled: false }); assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { id, disabled: false });
    assert.equal(authAccounts[id].disabled, false); assert.deepEqual(accounts[id], { ...before, disabled: false, updatedAt: accounts[id].updatedAt });
  }
  assert.equal(revoked.length, 0); assert.equal(audits.length, 4);
  assert.ok(audits.every(audit => audit.action === 'user_activated' && audit.details.previouslyDisabled === true));
});
test('LGU Admin, BO, resident and unauthenticated callers cannot reactivate', async () => {
  disabled('resident');
  for (const role of ['LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT', null]) assert.equal((await patch('resident', role, { disabled: false })).status, role ? 403 : 401);
  assert.equal(writes.length, 0); assert.equal(authCalls.length, 0);
});
test('BO deactivation preserves staff boundaries and deletion stays forbidden', async () => {
  assert.equal((await patch('official', 'LGU_ADMIN')).status, 403); assert.equal((await patch('official')).status, 200);
  assert.equal(accounts.official.barangayId, 'barangay_santol');
  assert.equal((await fetch(base + '/official', { method: 'DELETE', headers: { 'x-role': 'SUPER_ADMIN' } })).status, 403);
});
test('non-admins cannot deactivate and LGU Admin cannot change staff accounts', async () => {
  for (const role of ['RESIDENT', 'BARANGAY_OFFICIAL']) assert.equal((await patch('resident', role)).status, 403);
  assert.equal((await patch('admin', 'LGU_ADMIN')).status, 403); assert.equal((await patch('admin')).status, 200);
});
test('own-account status and last-active-Super-Admin safeguards are retained', async () => {
  assert.equal((await patch('caller')).status, 400); assert.equal((await patch('super')).status, 409);
  assert.equal(authCalls.length, 0); assert.equal(writes.length, 0);
});
test('missing profiles or Firebase Auth accounts never create or replace accounts', async () => {
  assert.equal((await patch('missing')).status, 404); delete authAccounts.resident;
  assert.equal((await patch('resident', 'SUPER_ADMIN', { disabled: false })).status, 404); assert.equal(writes.length, 0);
});
test('Auth failures do not write profiles or success audits', async () => {
  failAuth = true; assert.equal((await patch('resident')).status, 503);
  assert.equal(writes.length, 0); assert.equal(accounts.resident.disabled, false); assert.equal(audits.length, 0);
});
for (const stage of ['firestore', 'audit', 'revoke']) test(stage + ' failure restores Auth to the persisted profile without a false success audit', async () => {
  if (stage === 'firestore') failFirestore = true;
  if (stage === 'audit') failAudit = true;
  if (stage === 'revoke') failRevoke = true;
  assert.equal((await patch('resident')).status, 500);
  assert.equal(authAccounts.resident.disabled, false); assert.equal(accounts.resident.disabled, false); assert.equal(audits.length, 0);
});
test('failed reactivation keeps the account disabled and supports a safe retry', async () => {
  disabled('official'); failFirestore = true;
  assert.equal((await patch('official', 'SUPER_ADMIN', { disabled: false })).status, 500);
  assert.equal(authAccounts.official.disabled, true); assert.equal(accounts.official.disabled, true);
  failFirestore = false; assert.equal((await patch('official', 'SUPER_ADMIN', { disabled: false })).status, 200);
  assert.equal(accounts.official.barangayId, 'barangay_santol'); assert.equal(audits.length, 1);
});
test('recovery failure is explicitly reported and a disabled profile still denies private access', async () => {
  disabled('resident'); failFirestore = failRecovery = true;
  const response = await patch('resident', 'SUPER_ADMIN', { disabled: false }); assert.equal(response.status, 503);
  assert.match((await response.json()).error, /could not be confirmed/); assert.equal(accounts.resident.disabled, true); assert.equal(audits.length, 0);
});
test('stale edits cannot overwrite newer profile changes', async () => {
  disabled('resident'); staleEdit = true;
  assert.equal((await patch('resident', 'SUPER_ADMIN', { disabled: false })).status, 409);
  assert.equal(authAccounts.resident.disabled, true); assert.equal(accounts.resident.disabled, true); assert.equal(audits.length, 0);
});
test('an unavailable recovery read still attempts to restore the original Auth status and reports uncertainty', async () => {
  disabled('resident'); failRecoveryRead = true;
  assert.equal((await patch('resident', 'SUPER_ADMIN', { disabled: false })).status, 503);
  assert.equal(authAccounts.resident.disabled, true); assert.equal(accounts.resident.disabled, true); assert.equal(audits.length, 0);
});
test('a lost commit acknowledgement aligns Auth with the committed profile instead of undoing it', async () => {
  disabled('resident'); ambiguousCommit = true;
  assert.equal((await patch('resident', 'SUPER_ADMIN', { disabled: false })).status, 500);
  assert.equal(authAccounts.resident.disabled, false); assert.equal(accounts.resident.disabled, false); assert.equal(audits.length, 1);
});
test('concurrent requests cannot leave Authentication and the profile with opposing statuses', async () => {
  disabled('resident');
  const responses = await Promise.all([patch('resident', 'SUPER_ADMIN', { disabled: false }), patch('resident', 'SUPER_ADMIN', { disabled: false })]);
  assert.ok(responses.every(response => [200,409].includes(response.status)));
  assert.ok(responses.some(response => response.status === 200));
  assert.equal(authAccounts.resident.disabled, accounts.resident.disabled);
});
test('repeated requests leave one existing UID/profile and no duplicate linked records', async () => {
  disabled('resident');
  for (let i = 0; i < 2; i++) assert.equal((await patch('resident', 'SUPER_ADMIN', { disabled: false })).status, 200);
  assert.deepEqual(Object.keys(accounts).sort(), Object.keys(initial).sort()); assert.equal(accounts.resident.householdId, 'keep'); assert.equal(accounts.resident.displayId, 'ACC-00003');
});
