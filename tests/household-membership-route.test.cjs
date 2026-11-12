const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { householdStore } = require('./helpers/householdStore.cjs');

test('authenticated preview, linking request and head decision use the real membership API with a private projection', async () => {
  const { db, records } = householdStore();
  require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
  require.cache[require.resolve('../dist/middleware/auth')] = { exports: { requireAuth(req, res, next) {
    const uid = req.headers.authorization?.replace(/^Bearer /, '');
    const profile = records.get(`users/${uid}`);
    if (!profile) return res.status(401).json({ error: 'Sign in first.' });
    req.user = { uid, role: profile.role, name: profile.name, barangayId: profile.barangayId }; req.profile = profile; next();
  } } };
  const app = express(); app.use(express.json()); app.use('/households', require('../dist/routes/households').default);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const base = `http://127.0.0.1:${server.address().port}/households`;
  const post = (path, uid, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(uid ? { Authorization: `Bearer ${uid}` } : {}) }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/preview', null, { reference: 'HH-00001' })).status, 401);
    const preview = await post('/preview', 'maria', { reference: 'HH-00001' });
    const data = (await preview.json()).data;
    assert.equal(preview.status, 200); assert.equal(data.members.length, 3);
    assert.equal(data.contact, undefined); assert.equal(data.street, undefined); assert.equal(data.members[0].userId, undefined);
    const qr = await post('/preview', 'maria', { reference: JSON.stringify({ app: 'ligtas', version: 1, householdId: 'H-DELACRUZ' }) });
    assert.equal(qr.status, 200);
    assert.deepEqual((await qr.json()).data, data);
    const created = await post('/join', 'maria', { reference: 'HH-00001', memberId: 'manual-maria', userId: 'other' });
    assert.equal(created.status, 201);
    const request = (await created.json()).data;
    assert.equal(records.get(`householdRequests/${request.id}`).userId, 'maria');
    assert.equal((await post(`/requests/${request.id}/decision`, 'other', { approve: true })).status, 403);
    assert.equal((await post(`/requests/${request.id}/decision`, 'juan', { approve: true })).status, 400);
    assert.equal(records.get('households/H-DELACRUZ').members[1].userId, undefined);
    assert.equal((await post(`/requests/${request.id}/decision`, 'juan', { approve: true, identityConfirmed: true })).status, 200);
    assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
    assert.equal(records.get('households/H-DELACRUZ').members[1].userId, 'maria');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
