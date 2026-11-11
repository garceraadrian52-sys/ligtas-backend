const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

const documents = new Map([
  ['users/resident-uid', { role: 'RESIDENT', displayId: 'ACC-00042' }],
  ['users/other-uid', { role: 'RESIDENT', accountId: 'ACC-00042', displayId: 'ACC-00042' }],
  ['recordIdCounters/users', { prefix: 'ACC-', lastIssued: 42 }],
]);
const ref = path => ({ path, id: path.split('/').at(-1) });
const snapshot = (id, data) => ({ id, exists: data !== undefined, data: () => data });
const db = {
  doc: ref,
  collection(name) {
    assert.equal(name, 'users');
    return {
      async get() { return { docs: [...documents.entries()].filter(([path]) => path.startsWith('users/')).map(([path, data]) => snapshot(path.split('/').at(-1), data)) }; },
      where(field, operator, value) {
        assert.equal(operator, '==');
        return { query: true, field, value };
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      async get(reference) {
        if (reference.query) {
          const docs = [...documents.entries()].filter(([path, data]) => path.startsWith('users/') && data[reference.field] === reference.value)
            .map(([path, data]) => snapshot(path.split('/').at(-1), data));
          return { docs };
        }
        return snapshot(reference.id, documents.get(reference.path));
      },
      update(reference, value) { writes.push([reference.path, { ...documents.get(reference.path), ...value }]); },
      set(reference, value, options) { writes.push([reference.path, options?.merge ? { ...documents.get(reference.path), ...value } : value]); },
    };
    const result = await callback(transaction);
    writes.forEach(([path, data]) => documents.set(path, data));
    return result;
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth: {} } };
require.cache[require.resolve('../dist/middleware/auth')] = { exports: { requireAuth(req, _res, next) {
  req.user = { uid: req.get('x-uid') || 'resident-uid', role: req.get('x-role') || 'RESIDENT' };
  next();
} } };

const app = express();
app.use(express.json());
app.use('/users', require('../dist/routes/users').default);
let server;
let base;
before(async () => {
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}/users/account-id`;
});
after(() => { server.closeAllConnections(); server.close(); });

test('authenticated profiles reuse unique ACC display IDs and advance the counter', async () => {
  const response = await fetch(base, { method: 'POST', headers: { 'x-uid': 'resident-uid' } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.accountId, 'ACC-00043');
  assert.equal(documents.get('users/resident-uid').accountId, 'ACC-00043');
  assert.equal(documents.get('recordIdCounters/users').lastIssued, 43);
});

test('existing canonical account IDs are returned without allocation', async () => {
  documents.set('users/finished-uid', { role: 'BARANGAY_OFFICIAL', accountId: 'ACC-00100', displayId: 'ACC-00100' });
  const response = await fetch(base, { method: 'POST', headers: { 'x-uid': 'finished-uid' } });
  assert.equal((await response.json()).data.accountId, 'ACC-00100');
  assert.equal(documents.get('recordIdCounters/users').lastIssued, 43);
});

test('different authenticated profiles receive distinct IDs without accepting a body-supplied UID', async () => {
  documents.set('users/official-uid', { role: 'BARANGAY_OFFICIAL' });
  const response = await fetch(base, { method: 'POST', headers: { 'x-uid': 'official-uid', 'content-type': 'application/json' }, body: JSON.stringify({ uid: 'resident-uid' }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.accountId, 'ACC-00044');
  assert.equal(documents.get('users/official-uid').accountId, 'ACC-00044');
  assert.equal(documents.get('users/resident-uid').accountId, 'ACC-00043');
});

test('legacy account ID assignment fails closed when its counter is corrupt', async () => {
  documents.set('users/legacy-uid', { role: 'RESIDENT', displayId: 'ACC-00045' });
  documents.set('recordIdCounters/users', { lastIssued: 'corrupt' });
  const response = await fetch(base, { method: 'POST', headers: { 'x-uid': 'legacy-uid' } });
  assert.equal(response.status, 503);
  assert.equal(documents.get('users/legacy-uid').accountId, undefined);
  assert.deepEqual(documents.get('recordIdCounters/users'), { lastIssued: 'corrupt' });
});
