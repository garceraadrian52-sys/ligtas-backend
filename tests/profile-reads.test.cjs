const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

let profile = { role: 'RESIDENT', name: 'Resident', phone: '555-0100', address: 'Wawa' };
let documentReads = 0;
let documentWrites = 0;
const db = {
  doc(path) {
    assert.equal(path, 'users/resident-1');
    return {
      async get() {
        documentReads++;
        return { id: 'resident-1', exists: true, data: () => ({ ...profile }) };
      },
      async update(updates) {
        documentWrites++;
        profile = { ...profile, ...updates };
      },
    };
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: { db, auth: { verifyIdToken: async () => ({ uid: 'resident-1', email: 'resident@example.com' }) } },
};

const app = express();
app.use(express.json());
app.use('/profile', require('../dist/routes/profile').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/profile`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const request = (path = '', options = {}) => fetch(base + path, {
  ...options,
  headers: { Authorization: 'Bearer valid-token', ...(options.headers || {}) },
});

test('profile GET reuses the authenticated profile snapshot', async () => {
  documentReads = 0;
  const response = await request();
  const { data } = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(data, { id: 'resident-1', ...profile });
  assert.equal(documentReads, 1);
});

test('profile PATCH returns the updated snapshot without a follow-up read', async () => {
  documentReads = 0;
  documentWrites = 0;
  const response = await request('', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Name', phone: '555-0200' }),
  });
  const { data } = await response.json();

  assert.equal(response.status, 200);
  assert.equal(documentReads, 1);
  assert.equal(documentWrites, 1);
  assert.equal(data.id, 'resident-1');
  assert.equal(data.name, 'New Name');
  assert.equal(data.displayName, 'New Name');
  assert.equal(data.phone, '555-0200');
  assert.equal(typeof data.updatedAt._seconds, 'number');
  assert.equal(typeof data.updatedAt._nanoseconds, 'number');
});
