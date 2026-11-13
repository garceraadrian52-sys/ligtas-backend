const assert = require('node:assert/strict');
const { test } = require('node:test');
const { householdStore } = require('./helpers/householdStore.cjs');
const service = require('../dist/services/householdMembership');
// Retain main's scenario coverage against the unified transaction/API contracts.
const previewHousehold = (db, reference, uid) => service.previewHousehold(db, uid, reference);
const requestMembership = (db, reference, uid, input) => service.requestHouseholdJoin(db, uid, { ...input, reference });
const decideMembership = (db, id, uid, approve, identityConfirmed = false) => service.decideHouseholdMembership(db, uid, id, { approve, identityConfirmed });
const createResidentHousehold = async (...args) => (await service.createResidentHousehold(...args)).id;
const { validateHouseholdEdit } = require('../dist/services/householdEditing');
const link = (db, uid = 'maria', memberId = 'manual-maria') => requestMembership(db, 'H-DELACRUZ', uid, { memberId });

test('resident previews only minimum member identification and selects an existing manual member', async () => {
  const { db, records } = householdStore();
  const result = await previewHousehold(db, 'H-DELACRUZ', 'maria');
  assert.deepEqual(Object.keys(result).sort(), ['id', 'name', 'head', 'displayId', 'members'].sort());
  assert.deepEqual(result.members[1], { id: 'manual-maria', name: 'Maria Dela Cruz', relationship: 'Wife', linked: false });
  assert.equal(result.members[0].linked, true);
  const request = await link(db);
  assert.equal(records.get(`householdRequests/${request.id}`).name, 'Maria Registered Name');
  assert.equal(records.get(`householdRequests/${request.id}`).selectedMemberName, 'Maria Dela Cruz');
  assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
  assert.equal(records.get('users/maria').householdId, null);
  assert.equal((await previewHousehold(db, 'HH-00001', 'maria')).id, 'H-DELACRUZ');
  assert.equal((await previewHousehold(db, JSON.stringify({ app: 'ligtas', version: 1, householdId: 'H-DELACRUZ' }), 'maria')).id, 'H-DELACRUZ');
  records.get('users/maria').barangayId = 'other-area';
  const crossArea = await previewHousehold(db, 'H-DELACRUZ', 'maria');
  assert.equal(crossArea.id, 'H-DELACRUZ');
  assert.equal(crossArea.street, undefined);
  assert.equal(crossArea.contact, undefined);
});

test('head approval links exactly the selected record, preserves identity and member count, and is idempotent', async () => {
  const { db, records } = householdStore();
  const request = await link(db);
  await assert.rejects(decideMembership(db, request.id, 'other', true, true), error => error.status === 403);
  assert.equal((await decideMembership(db, request.id, 'juan', true, true)).status, 'Approved');
  assert.equal((await decideMembership(db, request.id, 'juan', true, true)).status, 'Approved');
  const household = records.get('households/H-DELACRUZ');
  assert.equal(household.members.length, 3);
  assert.deepEqual(household.members[1], { id: 'manual-maria', name: 'Maria Dela Cruz', relationship: 'Wife', userId: 'maria' });
  assert.equal(records.get('users/maria').householdMemberId, 'manual-maria');
  assert.equal(records.get('users/maria').householdId, 'H-DELACRUZ');
  assert.equal(records.get('users/maria').pendingHouseholdId, null);
  assert.equal(records.get(`householdRequests/${request.id}`).status, 'Approved');
});

test('already linked members and the legacy head cannot be selected', async () => {
  const { db, records } = householdStore();
  await assert.rejects(link(db, 'maria', 'head'), error => error.status === 409);
  delete records.get('households/H-DELACRUZ').members[0].userId;
  assert.equal((await previewHousehold(db, 'H-DELACRUZ', 'maria')).members[0].linked, true);
  await assert.rejects(link(db, 'maria', 'head'), error => error.status === 409);
});

test('not-listed requests add nobody until head approval and then create one linked member', async () => {
  const { db, records } = householdStore();
  const request = await requestMembership(db, 'H-DELACRUZ', 'other', { relationship: 'Son' });
  assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
  assert.equal(records.get('users/other').householdId, null);
  await decideMembership(db, request.id, 'juan', true, true);
  const member = records.get('households/H-DELACRUZ').members.at(-1);
  assert.deepEqual(member, { id: 'other', userId: 'other', name: 'Another resident', relationship: 'Son' });
  assert.equal(records.get('households/H-DELACRUZ').members.length, 4);
});

test('rejection clears the pending request without modifying household members', async () => {
  const { db, records } = householdStore();
  const before = structuredClone(records.get('households/H-DELACRUZ'));
  const request = await link(db);
  await decideMembership(db, request.id, 'juan', false);
  assert.deepEqual(records.get('households/H-DELACRUZ'), before);
  assert.equal(records.get('users/maria').householdId, null);
  assert.equal(records.get('users/maria').pendingHouseholdRequestId, null);
  assert.equal(records.get(`householdRequests/${request.id}`).status, 'Rejected');
  await assert.rejects(decideMembership(db, request.id, 'juan', true, true), /already been decided/);
});

test('two residents racing for one member produce one link and one conflict requiring head review', async () => {
  const { db, records } = householdStore();
  const requests = await Promise.all([link(db), link(db, 'other')]);
  const outcomes = await Promise.allSettled(requests.map(request => decideMembership(db, request.id, 'juan', true, true)));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled' && result.value.status === 'Approved').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 409);
  const members = records.get('households/H-DELACRUZ').members;
  assert.equal(members.length, 3);
  assert.equal(members.filter(member => ['maria', 'other'].includes(member.userId)).length, 1);
  const loser = requests[outcomes.findIndex(result => result.status === 'rejected')];
  assert.equal(records.get(`householdRequests/${loser.id}`).status, 'Pending');
  await decideMembership(db, loser.id, 'juan', false);
  assert.equal(records.get(`householdRequests/${loser.id}`).status, 'Rejected');
});

test('duplicate pending requests and joins to multiple households are blocked', async () => {
  const { db, records, household } = householdStore();
  records.set('households/H-SECOND', { ...household, createdBy: 'second-head', memberUids: ['second-head'], members: [{ id: 'head', userId: 'second-head', name: 'Head', relationship: 'Head' }] });
  const results = await Promise.allSettled([link(db), link(db)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(requestMembership(db, 'H-SECOND', 'maria', { relationship: 'Child' }), error => error.status === 409);
  const request = results.find(result => result.status === 'fulfilled').value;
  await decideMembership(db, request.id, 'juan', true, true);
  await assert.rejects(requestMembership(db, 'H-SECOND', 'maria', { relationship: 'Child' }), error => error.status === 409);
});

test('linking during an active evacuation preserves every attendance field and the selected member ID', async () => {
  const { db, records } = householdStore();
  const attendance = { householdId: 'H-DELACRUZ', memberIds: ['manual-maria'], memberNames: ['Maria Dela Cruz'], peopleCount: 1, status: 'checked_in' };
  const active = { householdId: 'H-DELACRUZ', memberIds: ['manual-maria'], evacuationCenterId: 'center' };
  records.set('evacuationRecords/history', attendance);
  records.set('activeEvacuations/H-DELACRUZ', active);
  records.set('evacuationCenters/center', { occupied: 1, capacity: 20 });
  const request = await link(db);
  await decideMembership(db, request.id, 'juan', true, true);
  assert.deepEqual(records.get('evacuationRecords/history'), attendance);
  assert.deepEqual(records.get('activeEvacuations/H-DELACRUZ'), active);
  assert.equal(records.get('evacuationCenters/center').occupied, 1);
  assert.equal(records.get('households/H-DELACRUZ').members.filter(member => member.id === 'manual-maria').length, 1);
});

test('manual edits/removal retain historical records and linked identities are protected', () => {
  const { records, household } = householdStore();
  const input = { name: household.name, street: household.street, contact: household.contact,
    expectedDetails: { name: household.name, street: household.street, contact: household.contact }, expectedMembers: structuredClone(household.members),
    members: structuredClone(household.members) };
  input.members[1].name = 'Maria Updated'; input.members.pop();
  const result = validateHouseholdEdit(input, household, 'juan');
  assert.equal(result.members.length, 2); assert.equal(result.members[1].name, 'Maria Updated');
  input.members[0].name = 'Overwritten registered name';
  assert.throws(() => validateHouseholdEdit(input, household, 'juan'), /identity information/);
  input.members.shift();
  assert.throws(() => validateHouseholdEdit(input, household, 'juan'), /Linked member IDs/);
  assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
});

test('household creation links only the head and keeps same-named people as separate manual members', async () => {
  const { db, records } = householdStore();
  await assert.rejects(createResidentHousehold(db, 'other', { name: 'New', street: 'Wawa', contact: '09123456789',
    members: [{ id: 'head', name: 'Head', relationship: 'Head' }, { id: 'forged', name: 'Other', relationship: 'Son', userId: 'maria' }] }), error => error.status === 400);
  const id = await createResidentHousehold(db, 'other', { name: 'New', street: 'Wawa', contact: '09123456789',
    members: [{ id: 'head', name: 'Spoofed name', relationship: 'Head' }, { id: 'manual-person', name: 'Another resident', relationship: 'Son' }] });
  const household = records.get(`households/${id}`);
  assert.equal(household.householdId, id);
  assert.equal(household.barangay, 'Wawa');
  assert.equal(household.members[0].name, 'Another resident');
  assert.equal(household.members[0].userId, 'other');
  assert.equal(household.members.length, 2);
  assert.equal(household.members[1].userId, undefined);
  await assert.rejects(createResidentHousehold(db, 'other', { name: 'Again', street: 'Wawa', contact: '09123456789', members: household.members }), error => error.status === 409);
});

test('existing-member approval requires explicit head identity confirmation and retains old pending requests', async () => {
  const { db, records } = householdStore();
  const request = await link(db);
  assert.equal(records.get(`householdRequests/${request.id}`).requestType, 'link_existing');
  await assert.rejects(decideMembership(db, request.id, 'juan', true), error => error.status === 400);
  assert.equal(records.get(`householdRequests/${request.id}`).status, 'Pending');
  assert.equal(records.get('households/H-DELACRUZ').members[1].userId, undefined);
  records.get(`householdRequests/${request.id}`).requestType = 'link_existing';
  await decideMembership(db, request.id, 'juan', true, true);
  assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
  assert.equal(records.get(`householdRequests/${request.id}`).identityConfirmedBy, 'juan');
});

test('legacy memberships without profile pointers prevent joining, creation and approval into another household', async () => {
  const { db, records } = householdStore();
  records.set('households/H-LEGACY', { createdBy: 'legacy-head', memberUids: ['maria'], members: [{ id: 'original-person', userId: 'maria', name: 'Maria' }] });
  await assert.rejects(link(db), error => error.status === 409);
  await assert.rejects(service.createResidentHousehold(db, 'maria', { name: 'Other', street: 'Street', contact: '9123456789',
    members: [{ id: 'head', name: 'Maria', relationship: 'Head' }] }), error => error.status === 409);
  records.set('householdRequests/legacy-request', { householdId: 'H-DELACRUZ', userId: 'maria', memberId: 'manual-maria', status: 'Pending' });
  Object.assign(records.get('users/maria'), { pendingHouseholdId: 'H-DELACRUZ', pendingHouseholdRequestId: 'legacy-request' });
  await assert.rejects(decideMembership(db, 'legacy-request', 'juan', true, true), error => error.status === 409);
  assert.equal(records.get('households/H-DELACRUZ').members[1].userId, undefined);
});

test('orphan Pending requests and pending request IDs block duplicate membership and creation', async () => {
  const { db, records } = householdStore();
  records.set('householdRequests/orphan', { householdId: 'H-OTHER', userId: 'maria', status: 'Pending' });
  await assert.rejects(link(db), error => error.status === 409);
  await assert.rejects(service.createResidentHousehold(db, 'maria', { name: 'Other', street: 'Street', contact: '9123456789',
    members: [{ id: 'head', name: 'Maria', relationship: 'Head' }] }), error => error.status === 409);
  records.delete('householdRequests/orphan');
  records.get('users/maria').pendingHouseholdRequestId = 'missing-pending-record';
  await assert.rejects(link(db), error => error.status === 409);
});

test('random-ID requests from newer main link the original row and clear both matching pending fields', async () => {
  const { db, records } = householdStore();
  records.set('householdRequests/random-legacy-id', { householdId: 'H-DELACRUZ', userId: 'maria', memberId: 'manual-maria',
    selectedMemberName: 'Maria Dela Cruz', relationship: 'Wife', status: 'Pending', requestVersion: 'random-legacy-id' });
  Object.assign(records.get('users/maria'), { pendingHouseholdId: 'H-DELACRUZ', pendingHouseholdRequestId: 'random-legacy-id', barangayId: 'another-area' });
  await decideMembership(db, 'random-legacy-id', 'juan', true, true);
  assert.equal(records.get('households/H-DELACRUZ').members[1].id, 'manual-maria');
  assert.equal(records.get('households/H-DELACRUZ').members[1].userId, 'maria');
  assert.equal(records.get('users/maria').pendingHouseholdRequestId, null);
  assert.equal(records.get('users/maria').pendingHouseholdId, null);
  assert.equal(records.get('householdRequests/random-legacy-id').decidedByName, 'Juan Dela Cruz');
});

test('stale rejection does not clear a newer pending request and legacy selected identity changes fail closed', async () => {
  const { db, records } = householdStore();
  records.set('householdRequests/old-request', { householdId: 'H-DELACRUZ', userId: 'maria', memberId: 'manual-maria', selectedMemberName: 'Old identity', status: 'Pending' });
  Object.assign(records.get('users/maria'), { pendingHouseholdId: 'H-DELACRUZ', pendingHouseholdRequestId: 'new-request' });
  await assert.rejects(decideMembership(db, 'old-request', 'juan', true, true), error => error.status === 409);
  await decideMembership(db, 'old-request', 'juan', false);
  assert.equal(records.get('users/maria').pendingHouseholdRequestId, 'new-request');
  assert.equal(records.get('users/maria').pendingHouseholdId, 'H-DELACRUZ');
  Object.assign(records.get('householdRequests/old-request'), { status: 'Pending' });
  records.get('users/maria').pendingHouseholdRequestId = 'old-request';
  await assert.rejects(decideMembership(db, 'old-request', 'juan', true, true), error => error.status === 409);
  assert.equal(records.get('households/H-DELACRUZ').members[1].userId, undefined);
});

test('duplicate legacy account links and invalid existing references require review without rewriting records', async () => {
  const { db, records, household } = householdStore();
  household.members[1].userId = 'juan';
  await assert.rejects(previewHousehold(db, 'H-DELACRUZ', 'maria'), error => error.status === 409);
  delete household.members[1].userId;
  household.displayId = 'legacy-unknown-reference';
  await assert.rejects(service.householdReference(db, 'juan', 'H-DELACRUZ'), error => error.status === 409);
  assert.equal(household.displayId, 'legacy-unknown-reference');
});

test('explicit existing-member requests cannot silently become add-new requests or accept unknown types', async () => {
  const { db, records } = householdStore();
  await assert.rejects(requestMembership(db, 'H-DELACRUZ', 'maria', { requestType: 'link_existing', relationship: 'Daughter' }), error => error.status === 400);
  await assert.rejects(requestMembership(db, 'H-DELACRUZ', 'maria', { requestType: 'unknown', relationship: 'Daughter' }), error => error.status === 400);
  const request = await requestMembership(db, 'H-DELACRUZ', 'maria', { relationship: 'Daughter' });
  records.get(`householdRequests/${request.id}`).requestType = 'unknown';
  await assert.rejects(decideMembership(db, request.id, 'juan', true), error => error.status === 409);
  assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
  assert.equal(records.get('users/maria').householdId, null);
});

test('approved legacy add-new requests without a stored memberId remain safely idempotent', async () => {
  const { db, records } = householdStore();
  const request = await requestMembership(db, 'H-DELACRUZ', 'other', { relationship: 'Son' });
  await decideMembership(db, request.id, 'juan', true);
  // Newer main's legacy schema left memberId null for an approved add-new row.
  records.get(`householdRequests/${request.id}`).memberId = null;
  const before = records.get('households/H-DELACRUZ');
  const beforeJson = JSON.stringify(before);
  assert.equal((await decideMembership(db, request.id, 'juan', true)).status, 'Approved');
  assert.equal(records.get('households/H-DELACRUZ'), before);
  assert.equal(JSON.stringify(records.get('households/H-DELACRUZ')), beforeJson);
  records.get('users/other').householdMemberId = 'different-person';
  await assert.rejects(decideMembership(db, request.id, 'juan', true), error => error.status === 409);
});
