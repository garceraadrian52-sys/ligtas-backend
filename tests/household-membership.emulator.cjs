const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { requestMembership, decideMembership } = require('../dist/services/householdMembership');

const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host)) throw new Error('Run these tests with the local Firestore emulator.');
const projectId = 'demo-ligtas-tests';
const app = initializeApp({ projectId }, 'household-membership-tests');
const db = getFirestore(app);

beforeEach(async () => {
  const response = await fetch(`http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  assert.equal(response.ok, true);
  await Promise.all([
    db.doc('users/head').set({ role: 'RESIDENT', name: 'Head', barangayId: 'wawa', householdId: 'H-ABCDE' }),
    db.doc('users/maria').set({ role: 'RESIDENT', name: 'Registered Maria', barangayId: 'wawa', householdId: null }),
    db.doc('users/other').set({ role: 'RESIDENT', name: 'Other', barangayId: 'wawa', householdId: null }),
    db.doc('households/H-ABCDE').set({ name: 'Dela Cruz', head: 'Head', createdBy: 'head', barangayId: 'wawa', memberUids: ['head'],
      members: [{ id: 'head', name: 'Head', relationship: 'Head', userId: 'head' },
        { id: 'original-maria', name: 'Maria Dela Cruz', relationship: 'Wife' },
        { id: 'original-ana', name: 'Ana', relationship: 'Daughter' }] }),
  ]);
});
after(async () => { await db.terminate(); await deleteApp(app); });

test('real Firestore transactions allow only one account to claim a member and preserve active attendance', async () => {
  await db.doc('activeEvacuations/H-ABCDE').set({ memberIds: ['original-maria'], evacuationCenterId: 'center' });
  await db.doc('evacuationRecords/history').set({ memberIds: ['original-maria'], memberNames: ['Maria Dela Cruz'], peopleCount: 1, status: 'checked_in', createdAt: new Date() });
  await db.doc('evacuationCenters/center').set({ occupied: 1, capacity: 10 });
  const history = (await db.doc('evacuationRecords/history').get()).data();
  const requests = await Promise.all(['maria', 'other'].map(uid => requestMembership(db, 'H-ABCDE', uid, { memberId: 'original-maria' })));
  const decisions = await Promise.all(requests.map(request => decideMembership(db, request.id, 'head', true, true)));
  assert.deepEqual(decisions.map(decision => decision.status).sort(), ['Approved', 'Rejected']);
  const household = (await db.doc('households/H-ABCDE').get()).data();
  assert.equal(household.members.length, 3);
  assert.equal(household.members[1].id, 'original-maria');
  assert.equal(household.members[1].name, 'Maria Dela Cruz');
  assert.equal(household.members[1].relationship, 'Wife');
  assert.ok(['maria', 'other'].includes(household.members[1].userId));
  assert.deepEqual((await db.doc('evacuationRecords/history').get()).data(), history);
  assert.equal((await db.doc('activeEvacuations/H-ABCDE').get()).data().memberIds[0], 'original-maria');
  assert.equal((await db.doc('evacuationCenters/center').get()).data().occupied, 1);
});

test('real concurrent requests from one account cannot reserve multiple households', async () => {
  await db.doc('households/H-SECOND').set({ name: 'Second', createdBy: 'another-head', barangayId: 'wawa', memberUids: ['another-head'],
    members: [{ id: 'head', userId: 'another-head', name: 'Head', relationship: 'Head' }] });
  const results = await Promise.allSettled(['H-ABCDE', 'H-SECOND'].map(id => requestMembership(db, id, 'maria', { relationship: 'Child' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const requests = await db.collection('householdRequests').where('userId', '==', 'maria').get();
  assert.equal(requests.size, 1);
  assert.equal(requests.docs[0].data().status, 'Pending');
  assert.equal((await db.doc('users/maria').get()).data().householdId, null);
});

test('official QR attendance uses stable member IDs after approval and keeps history private to officials', async () => {
  const { readFileSync } = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const mobile = path.resolve(__dirname, '../../ligtas-mobile');
  const ts = require(path.join(mobile, 'node_modules/typescript'));
  const firestore = require(path.join(mobile, 'node_modules/firebase/firestore'));
  const { initializeTestEnvironment, assertFails } = require(path.join(mobile, 'node_modules/@firebase/rules-unit-testing'));
  const [hostname, port] = host.split(':');
  const env = await initializeTestEnvironment({ projectId, firestore: { host: hostname, port: Number(port) } });
  const client = env.authenticatedContext('official').firestore();
  const load = (file, imports = {}) => {
    const exports = {};
    const code = ts.transpileModule(readFileSync(path.join(mobile, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    // Execute in the same realm as the SDK so Firestore accepts plain object payloads.
    vm.runInThisContext('(function(exports, require) {' + code + '\n})')(exports,
      name => { if (!(name in imports)) throw Error('Unexpected import: ' + name); return imports[name]; });
    return exports;
  };
  const validation = load('src/services/validation.ts');
  const plan = load('src/services/attendanceValidation.ts');
  let save;
  const attendance = load('src/services/attendance.ts', {
    'firebase/firestore': firestore, '@/services/firebase': { db: client, auth: { currentUser: { uid: 'official' } } },
    '@/services/outbox': { registerOutboxHandler: (kind, callback) => { assert.equal(kind, 'checkin'); save = callback; } },
    '@/services/attendanceValidation': plan, '@/services/readTimeout': { readWithTimeout: promise => promise }, '@/services/validation': validation,
  });
  try {
    await Promise.all([
      db.doc('users/official').set({ role: 'BARANGAY_OFFICIAL', name: 'Official', barangayId: 'wawa' }),
      db.doc('users/admin').set({ role: 'LGU_ADMIN', name: 'Admin' }),
      db.doc('evacuationCenters/center').set({ capacity: 10, occupied: 0, currentOccupancy: 0, occupancyCount: 0, status: 'OPEN' }),
    ]);
    const householdId = validation.parseHouseholdQr(validation.householdQr('H-ABCDE'));
    const recordRef = firestore.doc(client, 'evacuationRecords', 'before-join');
    const payload = { householdId, evacuationCenterId: 'center', evacuationCenter: 'Center', memberIds: ['original-maria'], memberNames: ['Maria Dela Cruz'] };
    await save({ id: 'before-join', ownerId: 'official', createdAt: new Date().toISOString(), payload });
    await attendance.checkoutAttendance('before-join');
    const history = (await firestore.getDoc(recordRef)).data();
    const request = await requestMembership(db, householdId, 'maria', { memberId: 'original-maria' });
    await decideMembership(db, request.id, 'head', true, true);
    const household = (await firestore.getDoc(firestore.doc(client, 'households', householdId))).data();
    assert.equal(household.members.length, 3); assert.equal(new Set(household.members.map(member => member.id)).size, 3);
    assert.equal(household.members[1].userId, 'maria'); assert.equal(household.members[2].userId, undefined);
    // Select only Maria and manually listed Ana; the absent head is not checked in.
    await save({ id: 'after-join', ownerId: 'official', createdAt: new Date().toISOString(), payload: { ...payload, memberIds: ['original-maria', 'original-ana'], memberNames: ['Maria Dela Cruz', 'Ana'] } });
    assert.deepEqual((await db.doc('evacuationRecords/after-join').get()).get('memberIds'), ['original-maria', 'original-ana']);
    assert.equal((await db.doc('evacuationCenters/center').get()).get('occupied'), 2);
    await save({ id: 'after-join', ownerId: 'official', createdAt: new Date().toISOString(), payload });
    assert.equal((await db.doc('evacuationCenters/center').get()).get('occupied'), 2);
    await attendance.checkoutAttendance('after-join');
    assert.equal((await db.doc('evacuationCenters/center').get()).get('occupied'), 0);
    assert.deepEqual((await firestore.getDoc(recordRef)).data(), history);
    assert.equal((await firestore.getDoc(firestore.doc(env.authenticatedContext('admin').firestore(), 'evacuationRecords', 'before-join'))).exists(), true);
    await assertFails(firestore.getDoc(firestore.doc(env.authenticatedContext('maria').firestore(), 'evacuationRecords', 'before-join')));
  } finally { await env.cleanup(); }
});
