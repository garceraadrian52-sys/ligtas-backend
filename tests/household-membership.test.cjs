const assert = require('node:assert/strict');
const { test } = require('node:test');
const { householdStore } = require('./helpers/householdStore.cjs');
const { previewHousehold, resolveJoinReference, requestMembership, decideMembership, createResidentHousehold } = require('../dist/services/householdMembership');
const { validateHouseholdEdit } = require('../dist/services/householdEditing');
const link = (db, uid = 'maria', memberId = 'manual-maria') => requestMembership(db, 'H-DELACRUZ', uid, { requestType: 'link_existing', memberId });

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
  assert.equal(await resolveJoinReference(db, 'HH-00001', records.get('users/maria')), 'H-DELACRUZ');
  assert.equal(await resolveJoinReference(db, JSON.stringify({ app: 'ligtas', version: 1, householdId: 'H-DELACRUZ' }), records.get('users/maria')), 'H-DELACRUZ');
  records.get('users/maria').barangayId = 'other-area';
  await assert.rejects(previewHousehold(db, 'H-DELACRUZ', 'maria'), error => error.status === 404);
});

test('head approval links exactly the selected record, preserves identity and member count, and is idempotent', async () => {
  const { db, records } = householdStore();
  const request = await link(db);
  await assert.rejects(decideMembership(db, request.id, 'other', true), error => error.status === 403);
  assert.equal((await decideMembership(db, request.id, 'juan', true)).status, 'Approved');
  assert.equal((await decideMembership(db, request.id, 'juan', true)).status, 'Approved');
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
  await assert.rejects(link(db, 'maria', 'head'), /Already Registered/);
  delete records.get('households/H-DELACRUZ').members[0].userId;
  assert.equal((await previewHousehold(db, 'H-DELACRUZ', 'maria')).members[0].linked, true);
  await assert.rejects(link(db, 'maria', 'head'), /Already Registered/);
});

test('not-listed requests add nobody until head approval and then create one linked member', async () => {
  const { db, records } = householdStore();
  const request = await requestMembership(db, 'H-DELACRUZ', 'other', { requestType: 'add_new', relationship: 'Son' });
  assert.equal(records.get('households/H-DELACRUZ').members.length, 3);
  assert.equal(records.get('users/other').householdId, null);
  await decideMembership(db, request.id, 'juan', true);
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
  await assert.rejects(decideMembership(db, request.id, 'juan', true), /already been decided/);
});

test('two residents racing for one member produce one link and one rejected conflict', async () => {
  const { db, records } = householdStore();
  const requests = await Promise.all([link(db), link(db, 'other')]);
  const outcomes = await Promise.all(requests.map(request => decideMembership(db, request.id, 'juan', true)));
  assert.deepEqual(outcomes.map(result => result.status).sort(), ['Approved', 'Rejected']);
  assert.match(outcomes.find(result => result.conflict).message, /already been linked/);
  const members = records.get('households/H-DELACRUZ').members;
  assert.equal(members.length, 3);
  assert.equal(members.filter(member => ['maria', 'other'].includes(member.userId)).length, 1);
  assert.equal(records.get('users/other').pendingHouseholdRequestId, null);
});

test('duplicate pending requests and joins to multiple households are blocked', async () => {
  const { db, records, household } = householdStore();
  records.set('households/H-SECOND', { ...household, createdBy: 'second-head', memberUids: ['second-head'], members: [{ id: 'head', userId: 'second-head', name: 'Head', relationship: 'Head' }] });
  const results = await Promise.allSettled([link(db), link(db)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(requestMembership(db, 'H-SECOND', 'maria', { requestType: 'add_new', relationship: 'Child' }), /pending approval/);
  const request = results.find(result => result.status === 'fulfilled').value;
  await decideMembership(db, request.id, 'juan', true);
  await assert.rejects(requestMembership(db, 'H-SECOND', 'maria', { requestType: 'add_new', relationship: 'Child' }), /already belongs/);
});

test('linking during an active evacuation preserves every attendance field and the selected member ID', async () => {
  const { db, records } = householdStore();
  const attendance = { householdId: 'H-DELACRUZ', memberIds: ['manual-maria'], memberNames: ['Maria Dela Cruz'], peopleCount: 1, status: 'checked_in' };
  const active = { householdId: 'H-DELACRUZ', memberIds: ['manual-maria'], evacuationCenterId: 'center' };
  records.set('evacuationRecords/history', attendance);
  records.set('activeEvacuations/H-DELACRUZ', active);
  records.set('evacuationCenters/center', { occupied: 1, capacity: 20 });
  const request = await link(db);
  await decideMembership(db, request.id, 'juan', true);
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
  const id = await createResidentHousehold(db, 'other', { name: 'New', street: 'Wawa', contact: '09123456789',
    members: [{ id: 'head', name: 'Spoofed name', relationship: 'Head' }, { id: 'manual-person', name: 'Another resident', relationship: 'Son', userId: 'maria' }] });
  const household = records.get(`households/${id}`);
  assert.equal(household.members[0].name, 'Another resident');
  assert.equal(household.members[0].userId, 'other');
  assert.equal(household.members.length, 2);
  assert.equal(household.members[1].userId, undefined);
  await assert.rejects(createResidentHousehold(db, 'other', { name: 'Again', street: 'Wawa', contact: '09123456789', members: household.members }), /already belongs/);
});
