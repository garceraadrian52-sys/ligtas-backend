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
  const requests = await Promise.all(['maria', 'other'].map(uid => requestMembership(db, 'H-ABCDE', uid, { requestType: 'link_existing', memberId: 'original-maria' })));
  const decisions = await Promise.all(requests.map(request => decideMembership(db, request.id, 'head', true)));
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
  const results = await Promise.allSettled(['H-ABCDE', 'H-SECOND'].map(id => requestMembership(db, id, 'maria', { requestType: 'add_new', relationship: 'Child' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const requests = await db.collection('householdRequests').where('userId', '==', 'maria').get();
  assert.equal(requests.size, 1);
  assert.equal(requests.docs[0].data().status, 'Pending');
  assert.equal((await db.doc('users/maria').get()).data().householdId, null);
});
