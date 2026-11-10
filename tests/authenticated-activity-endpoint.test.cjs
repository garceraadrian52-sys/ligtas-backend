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
    async recordAuthenticatedActivity(uid, authTime) { activityWrites.push({ uid, authTime }); },
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
  base = `http://127.0.0.1:${server.address().port}/users/activity`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('the activity endpoint requires a verified Firebase token', async () => {
  activityWrites.length = 0;
  const response = await fetch(base, { method: 'POST' });
  assert.equal(response.status, 401);
  assert.equal(activityWrites.length, 0);
});

test('a resident can record their own activity but cannot select another UID or timestamp', async () => {
  activityWrites.length = 0;
  role = 'RESIDENT';
  const response = await fetch(base, {
    method: 'POST',
    headers: { Authorization: 'Bearer valid-id-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: 'other-user', lastActiveAt: '1999-01-01T00:00:00Z' }),
  });

  assert.equal(response.status, 204);
  assert.deepEqual(activityWrites, [{ uid: 'firebase-token-uid', authTime: 1_800_000_000 }]);
});

test('official roles use the same authenticated activity endpoint', async () => {
  activityWrites.length = 0;
  role = 'BARANGAY_OFFICIAL';
  const response = await fetch(base, { method: 'POST', headers: { Authorization: 'Bearer valid-id-token' } });
  assert.equal(response.status, 204);
  assert.deepEqual(activityWrites, [{ uid: 'firebase-token-uid', authTime: 1_800_000_000 }]);
});
