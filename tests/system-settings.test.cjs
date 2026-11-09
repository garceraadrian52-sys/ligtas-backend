const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

process.env.LIGTAS_SYSTEM_VERSION = '1.0';
delete process.env.LIGTAS_LAST_UPDATED;
const writes = [];
let collectionReads = 0;
const db = {
  doc(path) {
    return {
      async get() {
        if (path === 'systemSettings/backupStatus') return { exists: false, data: () => undefined };
        if (path === 'systemSettings/statusProbe') return { exists: false };
        throw new Error(`Unexpected document read: ${path}`);
      },
      async set(data) { writes.push({ path, data }); },
    };
  },
  collection(name) {
    return {
      limit(max) {
        assert.equal(max, 501);
        return { async get() {
          collectionReads++;
          return { size: 1, docs: [{ id: 'record-1', data: () => ({ name: 'A record', password: 'never-export', privateToken: 'never-export', photoURL: 'data:image/png;base64,ZmFrZQ==' }) }] };
        } };
      },
    };
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) {
      req.user = { uid: 'caller', role: req.get('x-role') || 'LGU_ADMIN', name: 'Caller', email: 'caller@example.com' };
      next();
    },
  },
};
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { logAction: async () => undefined } };
require.cache[require.resolve('../dist/services/notificationWorker')] = { exports: { areNotificationWorkersStarted: () => false } };

const app = express();
app.use(express.json());
app.use('/settings', require('../dist/routes/settings').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/settings`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('system status is current, reports the worker runtime state and does not assert an unset update date', async () => {
  const response = await fetch(`${base}/system-status`, { headers: { 'x-role': 'SUPER_ADMIN' } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.version, '1.0');
  assert.equal(result.data.api, 'online');
  assert.equal(result.data.database, 'online');
  assert.equal(result.data.notifications, 'disabled');
  assert.equal(result.data.lastUpdated, null);
});

test('partial backup is Super Admin only, bounded, redacts secrets and reports its unsupported restore scope', async () => {
  const denied = await fetch(`${base}/backup`, { method: 'POST', headers: { 'x-role': 'LGU_ADMIN' } });
  assert.equal(denied.status, 403);
  assert.equal(collectionReads, 0);

  const response = await fetch(`${base}/backup`, { method: 'POST', headers: { 'x-role': 'SUPER_ADMIN' } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.partial, true);
  assert.equal(result.data.restoreSupported, false);
  assert.equal(result.data.collections.length, 5);
  const userRecord = result.data.collections.find(collection => collection.name === 'users').records[0];
  assert.equal(userRecord.id, 'record-1');
  assert.equal('password' in userRecord, false);
  assert.equal('privateToken' in userRecord, false);
  assert.equal(userRecord.photoURL, '[embedded image omitted from partial backup]');
  assert.equal(collectionReads, 5);
  assert.equal(writes[0].path, 'systemSettings/backupStatus');
});
