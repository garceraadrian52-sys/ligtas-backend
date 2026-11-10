const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');
const httpFetch = global.fetch.bind(global);

const previousApiKey = process.env.FIREBASE_WEB_API_KEY;
process.env.FIREBASE_WEB_API_KEY = 'test-key';
let credentialsValid = true;
const activityWrites = [];
const userId = 'admin-firebase-uid';
const db = {
  doc(path) {
    assert.equal(path, `users/${userId}`);
    return { async get() { return { data: () => ({ role: 'LGU_ADMIN', name: 'Test Admin', email: 'admin@example.test' }) }; } };
  },
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: {
    auth: { async verifyIdToken(token) {
      assert.equal(token, 'signed-in-id-token');
      return { uid: userId, auth_time: 1_800_000_000 };
    } },
    db,
  },
};
require.cache[require.resolve('../dist/services/activityTracking')] = {
  exports: {
    async recordAuthenticatedActivity(uid, authTime) { activityWrites.push({ uid, authTime }); },
  },
};
require.cache[require.resolve('../dist/services/firestoreErrors')] = {
  exports: { respondToFirestoreResourceExhausted() { return false; } },
};
global.fetch = async () => credentialsValid
  ? { ok: true, async json() { return { idToken: 'signed-in-id-token', localId: userId }; } }
  : { ok: false, async json() { return { error: { message: 'INVALID_PASSWORD' } }; } };

const app = express();
app.use(express.json());
app.use('/auth', require('../dist/routes/auth').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/auth/login`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  if (previousApiKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
  else process.env.FIREBASE_WEB_API_KEY = previousApiKey;
});

test('only a successful authorized interactive login records trusted login and activity time', async () => {
  activityWrites.length = 0;
  credentialsValid = true;
  const response = await httpFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'test-password' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(activityWrites, [{ uid: userId, authTime: 1_800_000_000 }]);
});

test('failed sign-in attempts do not create login or activity timestamps', async () => {
  activityWrites.length = 0;
  credentialsValid = false;
  const response = await httpFetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.test', password: 'wrong-password' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(activityWrites, []);
});
