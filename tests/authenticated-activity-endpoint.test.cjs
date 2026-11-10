const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

const activityWrites = [];
let role = 'RESIDENT';
const db = {
  doc(path) {
    assert.equal(path, 'users/firebase-token-uid');
    return { async get() { return { data: () => ({ role }) }; } };
  },
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: {
    auth: { async verifyIdToken(token) {
      assert.equal(token, 'valid-id-token');
      return { uid: 'firebase-token-uid', auth_time: 1_800_000_000 };
    } },
    db,
  },
};
require.cache[require.resolve('../dist/services/activityTracking')] = {
  exports: {
    async recordAuthenticatedActivity(uid) { activityWrites.push({ kind: 'activity', uid }); },
    async recordAuthenticatedLogin(uid, authTime) { activityWrites.push({ kind: 'login', uid, authTime }); },
    shouldTrackAuthenticatedActivity(value) { return ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT'].includes(value); },
  },
};
require.cache[require.resolve('../dist/services/firestoreErrors')] = {
  exports: {
    isFirestoreResourceExhausted() { return false; },
    respondToFirestoreResourceExhausted() { return false; },
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

test('activity and login endpoints require a verified Firebase token', async () => {
  activityWrites.length = 0;
  const [activity, login] = await Promise.all([
    fetch(`${base}/activity`, { method: 'POST' }),
    fetch(`${base}/login`, { method: 'POST' }),
  ]);
  assert.equal(activity.status, 401);
  assert.equal(login.status, 401);
  assert.equal(activityWrites.length, 0);
});

test('resident activity uses the verified UID and writes no client-provided login value', async () => {
  activityWrites.length = 0;
  role = 'RESIDENT';
  const response = await fetch(`${base}/activity`, {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-id-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'other-user', lastActiveAt: '1999-01-01T00:00:00Z', lastLoginAt: '1999-01-01T00:00:00Z' }),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(activityWrites, [{ kind: 'activity', uid: 'firebase-token-uid' }]);
});

test('resident interactive login uses only the verified UID and auth_time', async () => {
  activityWrites.length = 0;
  role = 'RESIDENT';
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-id-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'other-user', auth_time: 1, lastLoginAt: '1999-01-01T00:00:00Z' }),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(activityWrites, [{ kind: 'login', uid: 'firebase-token-uid', authTime: 1_800_000_000 }]);
});

test('administrator and Barangay Official roles use the authenticated login route', async () => {
  for (const accountRole of ['LGU_ADMIN', 'SUPER_ADMIN', 'BARANGAY_OFFICIAL']) {
    activityWrites.length = 0;
    role = accountRole;
    const response = await fetch(`${base}/login`, { method: 'POST', headers: { Authorization: 'Bearer valid-id-token' } });
    assert.equal(response.status, 204, accountRole);
    assert.deepEqual(activityWrites, [{ kind: 'login', uid: 'firebase-token-uid', authTime: 1_800_000_000 }], accountRole);
  }
});
