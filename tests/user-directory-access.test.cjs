const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

const account = {
  name: 'Barangay Official',
  displayName: 'Barangay Official',
  email: 'official@example.com',
  phone: '555-1234',
  role: 'BARANGAY_OFFICIAL',
  barangayId: 'barangay_longos',
  disabled: false,
  lastActiveAt: new Date('2026-11-09T02:00:00.000Z'),
  lastLoginAt: new Date('2026-11-08T18:00:00.000Z'),
  privateToken: 'must-not-leak',
};
const db = {
  collection(name) {
    assert.equal(name, 'users');
    return { async get() { return { docs: [
      { id: 'official-uid', data: () => ({ ...account }) },
      { id: 'resident-uid', data: () => ({ name: 'Resident Private', email: 'resident@example.com', role: 'RESIDENT', phone: '555-0000' }) },
    ] }; } };
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth: {} } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) {
      req.user = { uid: 'caller', role: req.get('x-role') || 'LGU_ADMIN', name: 'Caller', email: 'caller@example.com' };
      next();
    },
  },
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
  base = `http://127.0.0.1:${server.address().port}/users`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('LGU Admin can view user access capabilities and receives a read-only directory', async () => {
  const accessResponse = await fetch(`${base}/access`, { headers: { 'x-role': 'LGU_ADMIN' } });
  const access = await accessResponse.json();
  assert.equal(accessResponse.status, 200);
  assert.deepEqual(access.data, { canView: true, canManage: false, canBootstrapSuperAdmin: false, visibleRoles: [] });

  const listResponse = await fetch(base, { headers: { 'x-role': 'LGU_ADMIN' } });
  const list = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(list.data[0].id, 'official-uid');
  assert.equal(list.data[0].lastActiveAt, account.lastActiveAt.toISOString());
  assert.equal(list.data[0].lastLoginAt, account.lastLoginAt.toISOString());
  assert.equal('privateToken' in list.data[0], false);
  assert.equal(list.data.some(user => user.id === 'resident-uid'), false);
});

test('LGU Admin cannot create an account even if a Super Admin role is submitted', async () => {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-role': 'LGU_ADMIN' },
    body: JSON.stringify({ name: 'Attempted Admin', email: 'new@example.com', role: 'SUPER_ADMIN' }),
  });
  assert.equal(response.status, 403);
});
