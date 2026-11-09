const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const express = require('express');

let callerRole = 'SUPER_ADMIN';
let callerUid = 'admin-user';
let targetProfile = { role: 'LGU_ADMIN', email: 'target@example.com', displayId: 'USR0001' };
let targetAuth = { email: 'target@example.com', disabled: false, providerData: [{ providerId: 'password' }] };
let resetRequests;
let auditWrites;
const db = {
  doc(path) {
    assert.equal(path, 'users/target-user');
    return { async get() { return { exists: true, data: () => ({ ...targetProfile }) }; } };
  },
};
const auth = { getUser: async () => ({ ...targetAuth, providerData: [...(targetAuth.providerData ?? [])] }) };

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { auth, db } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: { requireAuth(req, _res, next) { req.user = { uid: callerUid, role: callerRole, name: 'Caller', email: 'caller@example.com' }; next(); } },
};
require.cache[require.resolve('../dist/services/auditLog')] = {
  exports: { logAction: async entry => { auditWrites.push(entry); } },
};

const app = express();
app.use(express.json());
app.use('/users', require('../dist/routes/users').default);
let server;
let base;
const originalFetch = global.fetch;

before(async () => {
  process.env.FIREBASE_WEB_API_KEY = 'test-only-api-key';
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/users/target-user/password-reset`;
});

beforeEach(() => {
  callerRole = 'SUPER_ADMIN';
  callerUid = 'admin-user';
  targetProfile = { role: 'LGU_ADMIN', email: 'target@example.com', displayId: 'USR0001' };
  targetAuth = { email: 'target@example.com', disabled: false, providerData: [{ providerId: 'password' }] };
  resetRequests = [];
  auditWrites = [];
  global.fetch = async (url, options) => {
    if (!String(url).includes('identitytoolkit.googleapis.com')) return originalFetch(url, options);
    resetRequests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ email: targetAuth.email }) };
  };
});

after(() => {
  global.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
});

const request = () => fetch(base, { method: 'POST', headers: { Authorization: 'Bearer verified', 'Content-Type': 'application/json' }, body: '{}' });

test('Super Admin sends a Firebase password-reset link to another staff account', async () => {
  const response = await request();
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, { sent: true });
  assert.equal(resetRequests.length, 1);
  assert.equal(resetRequests[0].body.requestType, 'PASSWORD_RESET');
  assert.equal(resetRequests[0].body.email, 'target@example.com');
  assert.equal(auditWrites[0].action, 'user_password_reset_requested');
  assert.equal(auditWrites[0].targetId, 'target-user');
});

test('LGU Admin cannot request resets for another account', async () => {
  callerRole = 'LGU_ADMIN';
  const response = await request();
  assert.equal(response.status, 403);
  assert.equal(resetRequests.length, 0);
});

test('Super Admin cannot use the other-user reset route for their own account', async () => {
  callerUid = 'target-user';
  const response = await request();
  assert.equal(response.status, 400);
  assert.equal(resetRequests.length, 0);
});

test('password reset is unavailable for accounts without email/password sign-in', async () => {
  targetAuth = { ...targetAuth, providerData: [{ providerId: 'google.com' }] };
  const response = await request();
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.match(payload.error, /email and password sign-in/);
  assert.equal(resetRequests.length, 0);
});
