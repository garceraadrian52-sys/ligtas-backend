const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
let role = 'LGU_ADMIN', barangayId = 'wawa', fail = false;
const queries = [];
const records = {
  reports: [{ type: 'road', barangayId: 'wawa', createdAt: '2026-10-01' }, { type: 'flood', barangayId: 'san-juan', createdAt: '2026-10-02' }],
  barangays: [{ id: 'wawa', name: 'Wawa' }, { id: 'san-juan', name: 'San Juan' }],
};
const db = {
  doc: () => ({ get: async () => ({ data: () => ({ role, barangayId }) }) }),
  collection(name) {
    let scoped = records[name];
    return { where(field, op, value) { queries.push({ name, field, value }); scoped = scoped.filter(item => item[field] === value); return this; },
      async get() { if (fail) throw new Error('offline'); return { docs: scoped.map((item, i) => ({ id: item.id || String(i), data: () => item })) }; } };
  },
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth: { verifyIdToken: async () => ({ uid: 'tester' }) } } };
const app = express(); app.use('/analytics', require('../dist/routes/analytics').default);
let server, base;
before(async () => { server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}/analytics/reports`; });
after(() => { server.closeAllConnections(); server.close(); });
const get = (suffix = '', auth = true) => fetch(base + suffix, { headers: auth ? { Authorization: 'Bearer test' } : {} });

test('analytics enforces sign-in and official role before reading data', async () => {
  assert.equal((await get('', false)).status, 401);
  role = 'RESIDENT'; assert.equal((await get()).status, 403);
  role = 'BARANGAY_OFFICIAL'; barangayId = null; assert.equal((await get()).status, 403);
});
test('official analytics include only the assigned barangay; administrators include all', async () => {
  role = 'BARANGAY_OFFICIAL'; barangayId = 'wawa'; queries.length = 0;
  const response = await get('?month=2026-10'); const { data } = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(data.total, 1); assert.equal(data.scope.label, 'Wawa');
  assert.equal(data.presentation.scopeLabel, 'Wawa'); assert.equal(data.presentation.metrics[0][2], '1');
  assert.deepEqual(queries, [{ name: 'reports', field: 'barangayId', value: 'wawa' }]);
  role = 'LGU_ADMIN'; queries.length = 0;
  const admin = await (await get()).json(); assert.equal(admin.data.total, 2); assert.equal(queries.length, 0);
});
test('bad month filters are rejected and database errors are never successful zero counts', async () => {
  role = 'LGU_ADMIN';
  for (const suffix of ['?month=2026-13', '?month=2026-10&month=2026-11', '?month=']) assert.equal((await get(suffix)).status, 400);
  fail = true; const response = await get(); assert.equal(response.status, 500); assert.equal((await response.json()).data, undefined); fail = false;
});
