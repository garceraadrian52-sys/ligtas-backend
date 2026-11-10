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
const residentAccount = { name: 'Resident Example', email: 'resident@example.com', role: 'RESIDENT', phone: '555-0000', barangayId: 'barangay_longos', displayId: 'USR0012', disabled: false, lastActiveAt: new Date('2026-11-09T03:00:00.000Z'), lastLoginAt: new Date('2026-11-08T19:00:00.000Z'), householdId: 'private-household', password: 'must-not-leak', pushToken: 'must-not-leak' };
const migratedResident = { name: 'Migrated Resident', email: 'migrated@example.com', role: 'RESIDENT', accountId: 'ACC-00012', displayId: 'ACC-00012' };
const db = {
  collection(name) {
    assert.equal(name, 'users');
    return { async get() { return { docs: [
      { id: 'official-uid', data: () => ({ ...account }) },
      { id: 'resident-uid', data: () => ({ ...residentAccount }) },
      { id: 'migrated-resident-uid', data: () => ({ ...migratedResident }) },
      { id: 'unknown-uid', data: () => ({ name: 'Unknown role', role: 'unknown-role' }) },
    ] }; } };
  },
  doc(path) {
    if (path === 'users/resident-uid') return { async get() { return { exists: true, data: () => ({ ...residentAccount }) }; } };
    throw new Error(`Unexpected document read: ${path}`);
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth: {} } };
const activityWrites = [];
require.cache[require.resolve('../dist/services/activityTracking')] = {
  exports: {
    async recordAuthenticatedActivity(uid) { activityWrites.push({ kind: 'activity', uid }); },
    async recordAuthenticatedLogin(uid, authTime) { activityWrites.push({ kind: 'login', uid, authTime }); },
    shouldTrackAuthenticatedActivity() { return true; },
  },
};
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) {
      req.user = { uid: 'verified-caller-uid', authTime: 1_800_000_000, role: req.get('x-role') || 'LGU_ADMIN', name: 'Caller', email: 'caller@example.com' };
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

test('LGU Admin can view user access capabilities and receives a safe read-only resident directory', async () => {
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
  const resident = list.data.find(user => user.id === 'resident-uid');
  assert.equal(resident.role, 'RESIDENT');
  assert.equal(resident.accountId, null);
  assert.equal(resident.displayId, null);
  const migrated = list.data.find(user => user.id === 'migrated-resident-uid');
  assert.equal(migrated.accountId, 'ACC-00012');
  assert.equal(migrated.displayId, 'ACC-00012');
  assert.equal(resident.barangayId, 'barangay_longos');
  assert.equal(resident.lastActiveAt, '2026-11-09T03:00:00.000Z');
  assert.equal(resident.lastLoginAt, '2026-11-08T19:00:00.000Z');
  assert.equal('householdId' in resident, false);
  assert.equal('password' in resident, false);
  assert.equal('pushToken' in resident, false);
  assert.equal('privateToken' in resident, false);
  assert.equal(list.data.some(user => user.id === 'unknown-uid'), false);
});

test('LGU Admin cannot create an account even if a Super Admin role is submitted', async () => {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-role': 'LGU_ADMIN' },
    body: JSON.stringify({ name: 'Attempted Admin', email: 'new@example.com', role: 'SUPER_ADMIN' }),
  });
  assert.equal(response.status, 403);
});

test('Super Admin resident account changes stay outside the staff-management endpoints', async () => {
  const patchResponse = await fetch(`${base}/resident-uid`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-role': 'SUPER_ADMIN' },
    body: JSON.stringify({ name: 'Changed', role: 'LGU_ADMIN' }),
  });
  assert.equal(patchResponse.status, 403);
  const deleteResponse = await fetch(`${base}/resident-uid`, { method: 'DELETE', headers: { 'x-role': 'SUPER_ADMIN' } });
  assert.equal(deleteResponse.status, 403);
});

test('activity endpoint records only the authenticated UID and never writes a login timestamp', async () => {
  activityWrites.length = 0;
  const response = await fetch(`${base}/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-role': 'RESIDENT' },
    body: JSON.stringify({ uid: 'another-account', lastActiveAt: '1999-01-01T00:00:00Z', lastLoginAt: '1999-01-01T00:00:00Z' }),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(activityWrites, [{ kind: 'activity', uid: 'verified-caller-uid' }]);
});

test('login endpoint derives UID and auth_time from the verified request context', async () => {
  activityWrites.length = 0;
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-role': 'RESIDENT' },
    body: JSON.stringify({ uid: 'another-account', auth_time: 1 }),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(activityWrites, [{ kind: 'login', uid: 'verified-caller-uid', authTime: 1_800_000_000 }]);
});
