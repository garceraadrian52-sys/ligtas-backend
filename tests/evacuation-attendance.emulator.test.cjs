const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host) {
  test('evacuation attendance real transaction integration', { skip: 'Requires local Firestore emulator' }, () => {});
} else {
  assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
  const projectId = 'demo-ligtas-attendance';
  const { initializeApp, deleteApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const app = initializeApp({ projectId }, 'attendance-regressions');
  const db = getFirestore(app);
  const { recordAttendance, checkoutCenterAttendance, attendanceHousehold } = require('../dist/services/evacuationAttendance');
  const express = require('express');
  // Real authorization middleware, token verification stubbed only at the Auth SDK boundary.
  require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth: { verifyIdToken: async token => ({ uid: token }) } } };
  // Reload the router/middleware after supplying the isolated emulator SDK.
  delete require.cache[require.resolve('../dist/middleware/auth')];
  delete require.cache[require.resolve('../dist/routes/evacuationCenters')];
  const api = express(); api.use(express.json()); api.use('/evacuation-centers', require('../dist/routes/evacuationCenters').default);
  let server, base;
  before(async () => { server = await new Promise(resolve => { const instance = api.listen(0, '127.0.0.1', () => resolve(instance)); }); base = 'http://127.0.0.1:' + server.address().port; });
  beforeEach(async () => {
    const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
    assert.equal(response.ok, true);
    await Promise.all(Object.entries({
      'barangays/borol_1st': { name: 'Borol 1st' }, 'barangays/borol_2nd': { name: 'Borol 2nd' },
      'users/operator': { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_1st' },
      'users/outsider': { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_2nd' },
      'users/resident': { role: 'RESIDENT', barangayId: 'borol_1st' },
      'users/disabled': { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_1st', disabled: true },
      'evacuationCenters/center': { name: 'Center', barangayId: 'borol_1st', capacity: 10, occupied: 0, currentOccupancy: 0, occupancyCount: 0, status: 'OPEN' },
      'households/H-ABCDE': { name: 'Household', displayId: 'HH-00001', barangayId: 'borol_2nd', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] },
    }).map(([path, data]) => db.doc(path).set(data)));
  });
  after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.terminate(); await deleteApp(app); });
  const input = (id, memberIds = ['a', 'b']) => ({ id, householdId: 'H-ABCDE', memberIds });
  const call = (path, uid = 'operator', body) => fetch(base + '/evacuation-centers' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(uid ? { Authorization: 'Bearer ' + uid } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  test('real concurrent cross-barangay checks and partial duplicates increment occupancy only for unique members', async () => {
    const results = await Promise.all([recordAttendance(db, 'operator', 'center', input('one')), recordAttendance(db, 'operator', 'center', input('two'))]);
    assert.equal(results.filter(result => result.status === 'checked_in').length, 1);
    assert.equal((await db.collection('evacuationRecords').get()).size, 1);
    assert.equal((await db.doc('evacuationCenters/center').get()).get('occupied'), 2);
    const partial = await recordAttendance(db, 'operator', 'center', input('partial', ['b', 'c'])); assert.equal(partial.addedCount, 1); assert.equal(partial.duplicateCount, 1);
    const record = (await db.doc('evacuationRecords/partial').get()).data(); assert.deepEqual(record.memberIds, ['c']); assert.equal(record.barangayId, 'borol_2nd');
    const center = (await db.doc('evacuationCenters/center').get()).data(); assert.deepEqual([center.occupied, center.currentOccupancy, center.occupancyCount], [3, 3, 3]);
    assert.equal((await db.doc('households/H-ABCDE').get()).get('members')[0].id, 'a');
  });
  test('real receipts keep duplicate/lost-response retries terminal after checkout and checkout retries decrement once', async () => {
    await recordAttendance(db, 'operator', 'center', input('first'));
    await recordAttendance(db, 'operator', 'center', input('duplicate'));
    await Promise.all([checkoutCenterAttendance(db, 'operator', 'center', 'first'), checkoutCenterAttendance(db, 'operator', 'center', 'first')]);
    assert.equal((await recordAttendance(db, 'operator', 'center', input('first'))).status, 'already_processed');
    assert.equal((await recordAttendance(db, 'operator', 'center', input('duplicate'))).status, 'already_checked_in');
    assert.equal((await recordAttendance(db, 'operator', 'center', { ...input('old-failed-duplicate'), duplicateReviewOnly: true })).status, 'already_processed');
    assert.equal((await db.doc('evacuationCenters/center').get()).get('occupied'), 0);
    assert.equal((await db.doc('evacuationRecords/first').get()).get('status'), 'checked_out');
    assert.equal((await db.collection('evacuationRecords').get()).size, 1);
  });
  test('real API requires authentication, center authorization and enabled official roles on every new endpoint', async () => {
    for (const uid of [null, 'resident', 'disabled', 'outsider']) {
      const expected = uid === null ? 401 : 403;
      assert.equal((await call('/center/household', uid, { reference: 'HH-00001' })).status, expected);
      assert.equal((await call('/center/attendance', uid, input('blocked'))).status, expected);
      assert.equal((await call('/center/attendance/missing/checkout', uid, {})).status, expected);
    }
    const response = await call('/center/attendance', 'operator', { ...input('accepted'), recordedBy: 'outsider', barangayId: 'borol_1st' });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.status, 'checked_in');
    const record = (await db.doc('evacuationRecords/accepted').get()).data(); assert.equal(record.recordedBy, 'operator'); assert.equal(record.barangayId, 'borol_2nd');
    assert.equal((await call('/attendance')).status, 200);
  });
  test('foreign municipality and unverified household references fail without mutating attendance', async () => {
    await db.doc('households/H-ABCDE').update({ municipalityId: 'other-municipality' });
    await assert.rejects(attendanceHousehold(db, 'operator', 'center', 'HH-00001'), error => error.status === 403);
    await assert.rejects(recordAttendance(db, 'operator', 'center', input('foreign')), error => error.status === 403);
    assert.equal((await db.collection('evacuationRecords').get()).size, 0);
    assert.equal((await db.doc('evacuationCenters/center').get()).get('occupied'), 0);
  });
}
