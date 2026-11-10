const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const express = require('express');

const users = {
  admin: { role: 'LGU_ADMIN', barangayId: null },
  superadmin: { role: 'SUPER_ADMIN', barangayId: null },
  official: { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_1st' },
  resident: { role: 'RESIDENT', barangayId: 'borol_1st' },
};
let mode;
let writes = 0;
let transactionQueue = Promise.resolve();

const db = {
  doc(path) {
    return {
      path,
      async get() {
        if (path.startsWith('users/')) {
          const value = users[path.slice('users/'.length)];
          return { exists: Boolean(value), data: () => value };
        }
        return { exists: Boolean(mode), data: () => mode ? { ...mode } : undefined };
      },
    };
  },
  async runTransaction(update) {
    const previous = transactionQueue;
    let release;
    transactionQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      let staged;
      const result = await update({
        async get() { return { exists: Boolean(mode), data: () => mode ? { ...mode } : undefined }; },
        set(_ref, value, options) {
          assert.deepEqual(options, { merge: true });
          staged = value;
        },
      });
      if (staged) {
        mode = { ...(mode ?? {}), ...staged };
        writes += 1;
      }
      return result;
    } finally {
      release();
    }
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: {
    auth: { async verifyIdToken(token) { return { uid: token, auth_time: 1_800_000_000 }; } },
    db,
  },
};
require.cache[require.resolve('../dist/services/firestoreErrors')] = {
  exports: {
    isFirestoreResourceExhausted() { return false; },
    respondToFirestoreResourceExhausted() { return false; },
  },
};

const app = express();
app.use(express.json());
app.use('/', require('../dist/routes/support').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/emergency-mode`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => { mode = undefined; writes = 0; transactionQueue = Promise.resolve(); });

async function call(token, method = 'GET', body) {
  return fetch(base, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('mode reads use the existing setting and return a Regular default when it is absent', async () => {
  const response = await call('admin');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { active: false, revision: 0 });
  mode = { active: true, changedBy: 'admin', revision: 7 };
  const updated = await call('official');
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).data, { active: true, changedBy: 'admin', revision: 7 });
  assert.equal((await call('resident')).status, 403);
});

test('authorized municipality administrators persist both mode transitions atomically', async () => {
  const emergency = await call('admin', 'PATCH', { active: true, expectedRevision: 0 });
  assert.equal(emergency.status, 200);
  const activeData = (await emergency.json()).data;
  assert.equal(activeData.active, true);
  assert.equal(activeData.revision, 1);
  assert.equal(activeData.changedBy, 'admin');
  assert.equal(typeof activeData.changedAt, 'string');
  assert.equal(mode.active, activeData.active);
  assert.equal(mode.revision, activeData.revision);
  assert.equal(mode.changedBy, activeData.changedBy);
  assert.equal(mode.changedAt.toISOString(), activeData.changedAt);

  const regular = await call('superadmin', 'PATCH', { active: false, expectedRevision: 1 });
  assert.equal(regular.status, 200);
  const regularData = (await regular.json()).data;
  assert.equal(regularData.active, false);
  assert.equal(regularData.revision, 2);
  assert.equal(regularData.changedBy, 'superadmin');
  assert.equal(writes, 2);
});

test('stale revisions fail without overwriting the newer confirmed mode', async () => {
  mode = { active: true, revision: 3, changedBy: 'admin' };
  const response = await call('admin', 'PATCH', { active: false, expectedRevision: 2 });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).data.active, true);
  assert.equal(mode.active, true);
  assert.equal(mode.revision, 3);
  assert.equal(writes, 0);
});

test('simultaneous updates based on one revision allow only one mode change', async () => {
  mode = { active: false, revision: 4, changedBy: 'admin' };
  const [first, second] = await Promise.all([
    call('admin', 'PATCH', { active: true, expectedRevision: 4 }),
    call('superadmin', 'PATCH', { active: true, expectedRevision: 4 }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(mode.active, true);
  assert.equal(mode.revision, 5);
  assert.equal(writes, 1);
});

test('mode writes require an administrator, a boolean state, and an expected revision', async () => {
  assert.equal((await call('official', 'PATCH', { active: true, expectedRevision: 0 })).status, 403);
  assert.equal((await call('resident', 'PATCH', { active: true, expectedRevision: 0 })).status, 403);
  assert.equal((await call('admin', 'PATCH', { active: 'true', expectedRevision: 0 })).status, 400);
  assert.equal((await call('admin', 'PATCH', { active: true })).status, 400);
  assert.equal(writes, 0);
});

test('mode endpoints require a verified Firebase ID token', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 401);
  assert.equal(writes, 0);
});
