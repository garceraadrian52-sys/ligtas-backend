const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateHouseholdEdit } = require('../dist/services/householdEditing');

const current = { createdBy: 'owner', name: 'Home', street: 'Wawa', contact: '9123456789',
  members: [{ id: 'head', name: 'Juan', relationship: 'Head of Household' },
    { id: 'resident', userId: 'resident', name: 'Maria', relationship: 'Spouse' }] };
const input = () => ({ name: current.name, street: current.street, contact: current.contact,
  expectedDetails: { name: current.name, street: current.street, contact: current.contact },
  members: structuredClone(current.members), expectedMembers: structuredClone(current.members) });

test('head can add an unlinked member while linked identity stays unchanged', () => {
  const update = input();
  update.members.push({ id: 'child', name: 'Ana', relationship: 'Daughter' });
  const result = validateHouseholdEdit(update, current, 'owner', undefined);
  assert.equal(result.members[1].userId, 'resident');
  assert.equal(result.members[1].name, 'Maria');
  assert.equal(result.members.length, 3);
  assert.equal(result.members[2].userId, undefined);
});

test('rejects unauthorized heads, linked account injection and existing member removal', () => {
  assert.throws(() => validateHouseholdEdit(input(), current, 'other'), /Only the household head/);
  const injected = input(); injected.members.push({ id: 'other', userId: 'other', name: 'Other', relationship: 'Sibling' });
  assert.throws(() => validateHouseholdEdit(injected, current, 'owner'), /Linked resident/);
  const removed = input(); removed.members.pop();
  assert.throws(() => validateHouseholdEdit(removed, current, 'owner'), /must be preserved/);
  const duplicate = input(); duplicate.members.push(duplicate.members[0]);
  assert.throws(() => validateHouseholdEdit(duplicate, current, 'owner'), /duplicated/);
});

test('rejects stale edits, invalid fields, and changes during active evacuation', () => {
  const stale = input(); stale.expectedMembers.pop();
  assert.throws(() => validateHouseholdEdit(stale, current, 'owner'), /changed/);
  const details = input(); details.expectedDetails.name = 'Old name';
  assert.throws(() => validateHouseholdEdit(details, current, 'owner'), /changed/);
  const oversized = input(); oversized.members.push({ id: 'manual', name: 'a'.repeat(121), relationship: 'Child' });
  assert.throws(() => validateHouseholdEdit(oversized, current, 'owner'), /member name/);
  const active = input(); active.members.push({ id: 'manual', name: 'Child', relationship: 'Child' });
  assert.throws(() => validateHouseholdEdit(active, current, 'owner', { memberIds: ['resident'] }), /active evacuation/);
  assert.throws(() => validateHouseholdEdit(active, current, 'owner', {}), /active evacuation/);
  assert.doesNotThrow(() => validateHouseholdEdit(active, current, 'owner', { memberIds: [] }));
  assert.doesNotThrow(() => validateHouseholdEdit(input(), current, 'owner', { memberIds: ['resident'] }));
});
