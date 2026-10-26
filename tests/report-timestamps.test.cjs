const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
let saved, writes = 0, audits = 0;
const reference = { id: 'test', get: async () => ({ id: 'test', data: () => saved }) };
const db = { doc: () => reference, runTransaction: async callback => callback({ get: async () => ({ exists: true, data: () => saved }), update: (_ref, updates) => { writes++; saved = { ...saved, ...updates }; } }) };
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
require.cache[require.resolve('../dist/middleware/auth')] = { exports: { requireAuth(req, res, next) { req.user = { role: 'LGU_ADMIN', uid: 'tester', name: 'Tester' }; next(); }, requireOfficial(req, res, next) { next(); } } };
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { logAction: async () => { audits++; } } };
const app = express(); app.use(express.json()); app.use('/reports', require('../dist/routes/reports').default);
let server, base;
before(async () => { server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}/reports/test`; });
after(() => { server.closeAllConnections(); server.close(); });
const update = status => fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
test('resolving preserves the review and verification times, and retrying preserves resolution time', async () => {
  const reviewedAt = new Date('2026-10-01T01:00:00Z');
  saved = { status: 'Verified', verification: 'Verified', createdAt: new Date('2026-10-01'), reviewedAt, verifiedAt: reviewedAt };
  assert.equal((await update('Resolved')).status, 200);
  assert.equal(saved.reviewedAt, reviewedAt); assert.equal(saved.verifiedAt, reviewedAt);
  const resolvedAt = saved.resolvedAt; const previousWrites = writes; const previousAudits = audits;
  assert.equal((await update('Resolved')).status, 200);
  assert.equal(saved.resolvedAt, resolvedAt); assert.equal(writes, previousWrites); assert.equal(audits, previousAudits);
  assert.equal((await update('Pending')).status, 200);
  assert.equal(saved.reviewedAt, null); assert.equal(saved.verifiedAt, null); assert.equal(saved.resolvedAt, null);
});
test('retrying a verification does not move the measured review time', async () => {
  saved = { status: 'Pending', verification: 'Pending' };
  assert.equal((await update('Verified')).status, 200);
  const verifiedAt = saved.verifiedAt; const reviewedAt = saved.reviewedAt;
  assert.equal((await update('Verified')).status, 200);
  assert.equal(saved.verifiedAt, verifiedAt); assert.equal(saved.reviewedAt, reviewedAt);
});
test('unreviewed reports cannot acquire a resolution event',async()=>{
  for(const status of ['Pending','Rejected']){
    saved={status,verification:status};
    assert.equal((await update('Resolved')).status,409);
    assert.equal(saved.resolvedAt,undefined);
  }
});
