const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { householdStore } = require('./helpers/householdStore.cjs');
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db: {} } };
const { recordAttendance, attendanceHousehold, checkoutCenterAttendance, listCenterAttendance } = require('../dist/services/evacuationAttendance');
let store;
beforeEach(() => {
  store = householdStore();
  store.records.set('barangays/borol_1st', { name: 'Borol 1st' });
  store.records.set('barangays/borol_2nd', { name: 'Borol 2nd' });
  store.records.set('users/bo', { role: 'BARANGAY_OFFICIAL', name: 'Operator', barangayId: 'borol_1st' });
  store.records.set('users/outsider', { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_2nd' });
  store.records.set('users/disabled', { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_1st', disabled: true });
  store.records.set('users/admin', { role: 'LGU_ADMIN', barangayId: null });
  store.records.set('evacuationCenters/center', { name: 'Center', barangayId: 'borol_1st', capacity: 10, occupied: 0, currentOccupancy: 0, occupancyCount: 0, status: 'OPEN' });
  store.records.set('evacuationCenters/other', { name: 'Other', barangayId: 'borol_2nd', capacity: 10, occupied: 0, status: 'OPEN' });
});
const input = (id = 'request-1', memberIds = ['manual-maria', 'manual-ana']) => ({
  id, householdId: 'H-DELACRUZ', memberIds, memberNames: memberIds.map(() => 'Untrusted client name'), observedAt: '2026-11-21T01:00:00.000Z',
});
const occupied = () => store.records.get('evacuationCenters/center').occupied;
const attendance = () => [...store.records].filter(([path]) => path.startsWith('evacuationRecords/'));

test('authorized center operator checks in another barangay household and preserves IDs, home barangay and previous history', async () => {
  const original = JSON.stringify(store.household);
  store.records.set('evacuationRecords/old-history', { status: 'checked_out', memberIds: ['manual-maria'], evidence: 'unchanged' });
  const result = await recordAttendance(store.db, 'bo', 'center', input());
  assert.equal(result.status, 'checked_in'); assert.equal(result.addedCount, 2); assert.equal(occupied(), 2);
  const record = store.records.get('evacuationRecords/request-1');
  assert.equal(record.barangayId, 'wawa'); assert.equal(record.centerBarangayId, 'borol_1st');
  assert.deepEqual(record.memberIds, ['manual-maria', 'manual-ana']);
  assert.deepEqual(record.memberNames, ['Maria Dela Cruz', 'Ana Dela Cruz']);
  assert.equal(JSON.stringify(store.household), original);
  assert.equal(store.records.get('evacuationRecords/old-history').evidence, 'unchanged');
});
test('all duplicates create no attendance record or occupancy increase, including at a now-full center', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  store.records.get('evacuationCenters/center').status = 'FULL';
  const result = await recordAttendance(store.db, 'bo', 'center', input('duplicate'));
  assert.equal(result.status, 'already_checked_in'); assert.equal(result.addedCount, 0);
  assert.equal(occupied(), 2); assert.equal(attendance().length, 1);
});
test('partial duplicates count and record only eligible members', async () => {
  await recordAttendance(store.db, 'bo', 'center', input('first', ['manual-maria']));
  const result = await recordAttendance(store.db, 'bo', 'center', input('second', ['manual-maria', 'manual-ana', 'head']));
  assert.equal(result.addedCount, 2); assert.equal(result.duplicateCount, 1);
  assert.equal(occupied(), 3);
  assert.deepEqual(store.records.get('evacuationRecords/second').memberIds, ['manual-ana', 'head']);
});
test('concurrent submissions for the same members record them once', async () => {
  const results = await Promise.all([recordAttendance(store.db, 'bo', 'center', input('one')), recordAttendance(store.db, 'bo', 'center', input('two'))]);
  assert.equal(results.filter(result => result.status === 'checked_in').length, 1);
  assert.equal(occupied(), 2); assert.equal(attendance().length, 1);
});
test('lost acknowledgments and stable submission retries never count the same request again', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  assert.equal((await recordAttendance(store.db, 'bo', 'center', input())).status, 'already_processed');
  assert.equal(occupied(), 2);
  await checkoutCenterAttendance(store.db, 'bo', 'center', 'request-1');
  assert.equal((await recordAttendance(store.db, 'bo', 'center', input())).status, 'already_processed');
  assert.equal(occupied(), 0);
});
test('all-duplicate receipt stays resolved after checkout instead of becoming a fresh check-in on retry', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  await recordAttendance(store.db, 'bo', 'center', input('duplicate'));
  await checkoutCenterAttendance(store.db, 'bo', 'center', 'request-1');
  assert.equal((await recordAttendance(store.db, 'bo', 'center', input('duplicate'))).status, 'already_checked_in');
  assert.equal(occupied(), 0); assert.equal(attendance().length, 1);
});
test('request IDs cannot be reused with changed members, a different center or another operator', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  await assert.rejects(recordAttendance(store.db, 'bo', 'center', input('request-1', ['head'])), error => error.status === 409);
  store.records.set('users/other-bo', { role: 'BARANGAY_OFFICIAL', barangayId: 'borol_1st' });
  await assert.rejects(recordAttendance(store.db, 'other-bo', 'center', input()), error => error.status === 409);
  assert.equal(occupied(), 2);
});
test('a household from the operator barangay still cannot be checked into an unauthorized center', async () => {
  store.household.barangayId = 'borol_1st';
  await assert.rejects(recordAttendance(store.db, 'bo', 'other', input()), error => error.status === 403);
  assert.equal(attendance().length, 0); assert.equal(occupied(), 0);
});
test('resident and disabled accounts cannot look up households, check in or check out', async () => {
  for (const uid of ['maria', 'disabled']) {
    await assert.rejects(attendanceHousehold(store.db, uid, 'center', 'HH-00001'), error => error.status === 403);
    await assert.rejects(recordAttendance(store.db, uid, 'center', input()), error => error.status === 403);
    await assert.rejects(checkoutCenterAttendance(store.db, uid, 'center', 'record'), error => error.status === 403);
  }
});
test('unknown/foreign municipality household, center and official assignments are rejected', async () => {
  store.records.set('barangays/foreign', { name: 'Foreign', municipalityId: 'other-lgu' });
  store.household.barangayId = 'foreign';
  await assert.rejects(recordAttendance(store.db, 'bo', 'center', input()), error => error.status === 403);
  store.household.barangayId = 'wawa'; store.household.municipalityId = 'other-lgu';
  await assert.rejects(attendanceHousehold(store.db, 'bo', 'center', 'HH-00001'), error => error.status === 403);
  delete store.household.municipalityId;
  store.records.get('evacuationCenters/center').municipalityId = 'other-lgu';
  await assert.rejects(recordAttendance(store.db, 'bo', 'center', input()), error => error.status === 403);
  assert.equal(occupied(), 0);
});
test('QR and display-ID lookups return only verified check-in identity fields', async () => {
  for (const reference of ['HH-00001', 'H-DELACRUZ', JSON.stringify({ app: 'ligtas', version: 1, householdId: 'H-DELACRUZ' })]) {
    const result = await attendanceHousehold(store.db, 'bo', 'center', reference);
    assert.equal(result.id, 'H-DELACRUZ'); assert.equal(result.members.length, 3);
    assert.equal(result.head, 'Juan Dela Cruz');
    assert.equal(result.street, undefined); assert.equal(result.contact, undefined); assert.equal(result.memberUids, undefined);
  }
  await assert.rejects(attendanceHousehold(store.db, 'outsider', 'center', 'HH-00001'), error => error.status === 403);
  await assert.rejects(attendanceHousehold(store.db, 'bo', 'center', '{"app":"other","version":1,"householdId":"H-DELACRUZ"}'), error => error.status === 400);
});
test('invalid members, insufficient capacity and inconsistent occupancy cannot mutate records', async () => {
  await assert.rejects(recordAttendance(store.db, 'bo', 'center', input('bad', ['unknown'])), error => error.status === 409);
  store.records.get('evacuationCenters/center').capacity = 1;
  await assert.rejects(recordAttendance(store.db, 'bo', 'center', input()), error => error.status === 409);
  store.records.get('evacuationCenters/center').capacity = 10;
  store.records.get('evacuationCenters/center').occupancyCount = 4;
  await assert.rejects(recordAttendance(store.db, 'bo', 'center', input()), error => error.status === 409);
  assert.equal(occupied(), 0); assert.equal(attendance().length, 0);
});
test('cross-barangay checkout and concurrent retries decrement only once and preserve history', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  await assert.rejects(checkoutCenterAttendance(store.db, 'outsider', 'center', 'request-1'), error => error.status === 403);
  await Promise.all([checkoutCenterAttendance(store.db, 'bo', 'center', 'request-1'), checkoutCenterAttendance(store.db, 'bo', 'center', 'request-1')]);
  assert.equal(occupied(), 0);
  assert.equal(store.records.get('evacuationRecords/request-1').status, 'checked_out');
  assert.deepEqual(store.records.get('evacuationRecords/request-1').memberIds, ['manual-maria', 'manual-ana']);
});
test('authorized listings include cross-barangay center occupants without trusting a forged center barangay field', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  assert.equal((await listCenterAttendance(store.db, 'bo')).length, 1);
  assert.equal((await listCenterAttendance(store.db, 'outsider')).length, 0);
  store.records.get('evacuationRecords/request-1').centerBarangayId = 'borol_2nd';
  assert.equal((await listCenterAttendance(store.db, 'outsider')).length, 0);
});
test('municipal administrators retain same-LGU center access without requiring a home barangay', async () => {
  assert.equal((await recordAttendance(store.db, 'admin', 'other', input())).status, 'checked_in');
  assert.equal(store.records.get('evacuationCenters/other').occupied, 2);
});

test('list preserves original offline observation times and legacy household display IDs', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  store.records.get('evacuationRecords/request-1').householdReference = 'HH-00001';
  const [record] = await listCenterAttendance(store.db, 'bo');
  assert.equal(record.recordedAt, Date.parse('2026-11-21T01:00:00.000Z'));
  assert.equal(record.householdDisplayId, 'HH-00001');
});

test('unknown attendance statuses cannot decrement occupancy', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  store.records.get('evacuationRecords/request-1').status = 'unknown';
  await assert.rejects(checkoutCenterAttendance(store.db, 'bo', 'center', 'request-1'), error => error.status === 409);
  assert.equal(occupied(), 2);
});

test('legacy duplicate review after checkout resolves without checking the household in again', async () => {
  await recordAttendance(store.db, 'bo', 'center', input());
  await checkoutCenterAttendance(store.db, 'bo', 'center', 'request-1');
  const result = await recordAttendance(store.db, 'bo', 'center', { ...input('legacy-duplicate'), duplicateReviewOnly: true });
  assert.equal(result.status, 'already_processed'); assert.equal(result.addedCount, 0);
  assert.equal(occupied(), 0); assert.equal(attendance().length, 1);
});
