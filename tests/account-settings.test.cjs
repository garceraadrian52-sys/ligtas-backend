const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const express = require('express');

let role = 'SUPER_ADMIN';
let accountProfile;
let firebaseUser;
let authUpdates;
let documentUpdates;
let identityRequests;
let identityResponse;
const db = {
  doc(path) {
    assert.equal(path, 'users/admin-user');
    return { async update(changes) { documentUpdates.push(changes); accountProfile = { ...accountProfile, ...changes }; } };
  },
};
const auth = {
  getUser: async () => ({ ...firebaseUser, providerData: [...(firebaseUser.providerData ?? [])] }),
  updateUser: async (_uid, changes) => { authUpdates.push(changes); },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { auth, db } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) {
      req.user = { uid: 'admin-user', role, barangayId: null, name: accountProfile.name, email: accountProfile.email };
      req.profile = { ...accountProfile };
      next();
    },
  },
};

const app = express();
app.use(express.json());
app.use('/profile', require('../dist/routes/profile').default);
let server;
let base;
const originalFetch = global.fetch;

before(async () => {
  process.env.FIREBASE_WEB_API_KEY = 'test-only-api-key';
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/profile`;
});

beforeEach(() => {
  role = 'SUPER_ADMIN';
  accountProfile = { role, name: 'Admin', displayName: 'Admin', email: 'admin@example.com', phone: '555-0100' };
  firebaseUser = { uid: 'admin-user', email: 'admin@example.com', disabled: false, emailVerified: false, providerData: [{ providerId: 'password' }] };
  authUpdates = [];
  documentUpdates = [];
  identityRequests = [];
  identityResponse = { ok: true, body: { localId: 'admin-user', idToken: 'fresh-id-token', email: 'admin@example.com' } };
  global.fetch = async (url, options) => {
    if (!String(url).includes('identitytoolkit.googleapis.com')) return originalFetch(url, options);
    identityRequests.push({ url: String(url), body: JSON.parse(options.body) });
    const result = typeof identityResponse === 'function' ? identityResponse(url, options) : identityResponse;
    return { ok: result.ok, status: result.status ?? (result.ok ? 200 : 400), json: async () => result.body };
  };
});

after(() => {
  global.fetch = originalFetch;
  server.closeAllConnections();
  server.close();
});

async function request(path, method, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: 'Bearer verified-session', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

for (const adminRole of ['SUPER_ADMIN', 'LGU_ADMIN']) {
  test(`${adminRole} changes their own password only after Firebase reauthentication confirms it`, async () => {
    role = adminRole;
    accountProfile.role = adminRole;
    identityResponse = (_url, options) => String(_url).includes('signInWithPassword')
      ? { ok: true, body: { localId: 'admin-user', idToken: 'fresh-id-token' } }
      : { ok: true, body: { localId: 'admin-user', idToken: 'refreshed-id-token' } };
    const response = await request('/password', 'PATCH', { currentPassword: 'correct-current', newPassword: 'a-secure-new-password' });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, { updated: true, token: 'refreshed-id-token' });
    assert.match(identityRequests[0].url, /accounts:signInWithPassword/);
    assert.equal(identityRequests[0].body.password, 'correct-current');
    assert.match(identityRequests[1].url, /accounts:update/);
    assert.equal(identityRequests[1].body.password, 'a-secure-new-password');
    assert.deepEqual(authUpdates, []);
  });
}

test('incorrect current password has an error response and does not submit the new password', async () => {
  identityResponse = { ok: false, body: { error: { message: 'INVALID_PASSWORD' } } };
  const response = await request('/password', 'PATCH', { currentPassword: 'incorrect', newPassword: 'a-secure-new-password' });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.error, 'Your current password is incorrect.');
  assert.equal(identityRequests.length, 1);
  assert.deepEqual(authUpdates, []);
});

test('email change sends Firebase VERIFY_AND_CHANGE_EMAIL and leaves the saved email unchanged', async () => {
  identityResponse = (_url, options) => String(_url).includes('signInWithPassword')
    ? { ok: true, body: { localId: 'admin-user', idToken: 'fresh-id-token' } }
    : { ok: true, body: { email: 'new@example.com' } };
  const response = await request('/email/change', 'POST', { currentPassword: 'correct-current', newEmail: ' NEW@example.com ' });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.pendingEmail, 'new@example.com');
  assert.equal(accountProfile.email, 'admin@example.com');
  assert.equal(accountProfile.pendingEmail, 'new@example.com');
  assert.equal(identityRequests[1].body.requestType, 'VERIFY_AND_CHANGE_EMAIL');
  assert.equal(identityRequests[1].body.newEmail, 'new@example.com');
  assert.equal(authUpdates.length, 0);
});

test('LGU Admin can only synchronize the email after Firebase confirms verification', async () => {
  role = 'LGU_ADMIN';
  accountProfile.role = role;
  accountProfile.pendingEmail = 'new@example.com';
  firebaseUser = { ...firebaseUser, email: 'new@example.com', emailVerified: false };
  const notVerified = await request('/email/sync', 'POST', {});
  assert.equal(notVerified.status, 409);
  assert.equal(accountProfile.email, 'admin@example.com');

  firebaseUser = { ...firebaseUser, emailVerified: true };
  const verified = await request('/email/sync', 'POST', {});
  const payload = await verified.json();
  assert.equal(verified.status, 200);
  assert.equal(payload.data.email, 'new@example.com');
  assert.equal(accountProfile.email, 'new@example.com');
  assert.equal(accountProfile.pendingEmail, null);
});

test('an account without a password provider cannot have a password or email changed through password reauthentication', async () => {
  firebaseUser = { ...firebaseUser, providerData: [{ providerId: 'google.com' }] };
  const password = await request('/password', 'PATCH', { currentPassword: 'anything', newPassword: 'a-secure-new-password' });
  const payload = await password.json();
  assert.equal(password.status, 400);
  assert.match(payload.error, /linked sign-in provider/);
  assert.equal(identityRequests.length, 0);
});

test('email cannot be changed through the ordinary profile update endpoint', async () => {
  const response = await request('', 'PATCH', { email: 'unverified@example.com' });
  assert.equal(response.status, 400);
  assert.equal(accountProfile.email, 'admin@example.com');
  assert.equal(documentUpdates.length, 0);
  assert.equal(authUpdates.length, 0);
});

for (const adminRole of ['SUPER_ADMIN', 'LGU_ADMIN']) {
  test(`${adminRole} can update their own profile fields without changing role`, async () => {
    role = adminRole;
    accountProfile.role = adminRole;
    const response = await request('', 'PATCH', {
      name: 'Updated Admin', phone: '555-0200', barangayId: null, photoURL: 'data:image/jpeg;base64,YWJj',
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.data.name, 'Updated Admin');
    assert.equal(payload.data.phone, '555-0200');
    assert.equal(payload.data.role, adminRole);
    assert.equal(payload.data.photoURL, 'data:image/jpeg;base64,YWJj');
    assert.deepEqual(authUpdates, [{ displayName: 'Updated Admin' }]);
  });
}

test('self-service profile updates reject attempts to change account role', async () => {
  const response = await request('', 'PATCH', { role: 'SUPER_ADMIN' });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.match(payload.error, /role changes use separate authorized workflows/);
  assert.equal(documentUpdates.length, 0);
});
