const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');
const originalFetch = global.fetch;
const originalKey = process.env.FIREBASE_WEB_API_KEY;
process.env.FIREBASE_WEB_API_KEY = 'test-key';
let mode = 'registered';
let deliveries = 0;
let resetAudits = 0;
let resetRole = 'LGU_ADMIN';
require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: { auth: { async getUserByEmail(email) {
    assert.equal(email, 'applicant@example.test');
    if (mode === 'missing') throw { code: 'auth/user-not-found' };
    return { uid: 'account-id', disabled: mode === 'disabled' };
  } }, db: {doc:()=>({get:async()=>({data:()=>({role:resetRole})})})} },
};
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { logAction: async () => {resetAudits++;} } };
global.fetch = async () => {
  deliveries++;
  return { ok: true, json: async () => ({ email: 'applicant@example.test' }) };
};
const app = express();
app.use(express.json());
app.use(require('../dist/routes/auth').default);
let server;
let base;
before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
  else process.env.FIREBASE_WEB_API_KEY = originalKey;
  server.closeAllConnections();
  server.close();
});
const reset = () => originalFetch(base + '/forgot-password', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'applicant@example.test' }),
});
test('only a registered, enabled account receives a password reset request', async () => {
  mode = 'missing';
  let response = await reset();
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /No registered account/);
  assert.equal(deliveries, 0);
  mode = 'disabled';
  assert.equal((await reset()).status, 403);
  assert.equal(deliveries, 0);
  mode = 'registered';
  assert.equal((await reset()).status, 202);
  assert.equal(deliveries, 1);
});

test('resident password reset requests are excluded from activity logs', async () => {
  resetRole='RESIDENT';
  const previous=resetAudits;
  assert.equal((await reset()).status,202);
  assert.equal(resetAudits,previous);
});
