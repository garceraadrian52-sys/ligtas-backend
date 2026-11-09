const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');
process.env.FIREBASE_WEB_API_KEY = 'test-only-api-key';

let storedRole = 'RESIDENT';
const auth = { verifyIdToken: async () => ({ uid: 'admin-user', auth_time: 1 }) };
const db = {
  doc(path) {
    assert.equal(path, 'users/admin-user');
    return { async get() { return { data: () => ({ role: storedRole, name: 'Admin', email: 'admin@example.com' }) }; } };
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { auth, db } };
require.cache[require.resolve('../dist/services/activityTracking')] = {
  exports: {
    recordAuthenticatedActivity: async () => undefined,
    shouldTrackAuthenticatedActivity: role => ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT'].includes(role),
  },
};
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { logAction: async () => undefined } };

const app = express();
app.use(express.json());
app.use('/users', require('../dist/routes/users').default);
app.use('/auth', require('../dist/routes/auth').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/users/access`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function accessFor(role) {
  storedRole = role;
  const response = await fetch(base, { headers: { Authorization: 'Bearer verified-token' } });
  return { response, payload: await response.json() };
}

test('recognized Super Admin spellings receive normalized full administrative capabilities', async () => {
  for (const role of ['superadmin', 'super_admin', 'Super Admin']) {
    const { response, payload } = await accessFor(role);
    assert.equal(response.status, 200, role);
    assert.equal(payload.data.canView, true, role);
    assert.equal(payload.data.canManage, true, role);
  }
});

test('recognized LGU Admin spellings receive the read-only directory capability', async () => {
  for (const role of ['lgu_admin', 'LGU Admin']) {
    const { response, payload } = await accessFor(role);
    assert.equal(response.status, 200, role);
    assert.equal(payload.data.canView, true, role);
    assert.equal(payload.data.canManage, false, role);
  }
});

test('resident and unrecognized stored roles cannot access the account directory', async () => {
  for (const role of ['RESIDENT', 'unrecognized-admin']) {
    const { response } = await accessFor(role);
    assert.equal(response.status, 403, role);
  }
});

test('admin login returns canonical roles for recognized Firestore role spellings', async () => {
  const nativeFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('identitytoolkit.googleapis.com')) {
      return { ok: true, json: async () => ({ localId: 'admin-user', idToken: 'test-id-token' }) };
    }
    return nativeFetch(url, options);
  };
  const root = base.replace('/users/access', '');
  try {
    for (const [role, canonical] of [
      ['superadmin', 'SUPER_ADMIN'], ['super_admin', 'SUPER_ADMIN'], ['Super Admin', 'SUPER_ADMIN'],
      ['lgu_admin', 'LGU_ADMIN'], ['LGU Admin', 'LGU_ADMIN'],
    ]) {
      storedRole = role;
      const response = await nativeFetch(`${root}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'admin@example.com', password: 'test-password' }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, role);
      assert.equal(payload.data.user.role, canonical, role);
    }
  } finally {
    global.fetch = nativeFetch;
  }
});

test('legacy Super Admin and LGU Admin spellings retain municipality-wide alert delivery', () => {
  const { inArea } = require('../dist/services/notificationPolicy');
  const barangayAlert = { coverageArea: 'barangay', barangayIds: ['barangay_wawa'] };
  for (const role of ['superadmin', 'super_admin', 'Super Admin', 'lgu_admin', 'LGU Admin']) {
    assert.equal(inArea(barangayAlert, { role, barangayId: 'barangay_dalig' }), true, role);
  }
});
