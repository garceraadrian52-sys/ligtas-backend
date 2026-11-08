const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

let account = { name: 'Current Name', displayName: 'Current Name', email: 'current@example.com', role: 'LGU_ADMIN', barangayId: null, phone: '555-0100', disabled: false };
let writes = 0;
let authUpdate = null;
let authFailure = null;
const db = {
  doc(path) {
    if (path === 'systemSettings/superAdminBootstrap') return {};
    assert.equal(path, 'users/target-user');
    return {
      async get() { return { id: 'target-user', exists: true, data: () => ({ ...account }) }; },
      async update(changes) { writes++; account = { ...account, ...changes }; },
    };
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: { db, auth: { updateUser: async (_uid, changes) => { authUpdate = changes; if (authFailure) throw authFailure; } } },
};
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: { requireAuth(req, _res, next) { req.user = { uid: 'admin-user', role: 'SUPER_ADMIN', name: 'Admin', email: 'admin@example.com' }; next(); } },
};
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { logAction: async () => undefined } };

const app = express();
app.use(express.json());
app.use('/users', require('../dist/routes/users').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/users/target-user`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('Super Admin updates email, name, phone and profile image while optional barangay stays null', async () => {
  writes = 0;
  authUpdate = null;
  authFailure = null;
  const response = await fetch(base, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
    body: JSON.stringify({ name: 'Updated Name', email: 'updated@example.com', phone: '555-0200', photoURL: 'data:image/jpeg;base64,YWJj', role: 'LGU_ADMIN', barangayId: null, disabled: false }),
  });
  const { data } = await response.json();

  assert.equal(response.status, 200);
  assert.equal(writes, 1);
  assert.equal(data.name, 'Updated Name');
  assert.equal(data.email, 'updated@example.com');
  assert.equal(data.phone, '555-0200');
  assert.equal(data.photoURL, 'data:image/jpeg;base64,YWJj');
  assert.equal(data.barangayId, null);
  assert.deepEqual(authUpdate, { displayName: 'Updated Name', email: 'updated@example.com', disabled: false });
});

test('Super Admin profile edits reject invalid image URLs before changing the account', async () => {
  writes = 0;
  const response = await fetch(base, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
    body: JSON.stringify({ photoURL: 'javascript:alert(1)' }),
  });

  assert.equal(response.status, 400);
  assert.equal(writes, 0);
});
