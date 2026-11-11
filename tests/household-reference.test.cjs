const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findHouseholdByDisplayId, normalizeHouseholdDisplayId } = require('../dist/services/householdReference');

function memoryFirestore(records) {
  return {
    collection(name) {
      assert.equal(name, 'households');
      return { where(field, operator, value) {
        assert.deepEqual([field, operator], ['displayId', '==']);
        return { async get() {
          const docs = records.filter(record => record.displayId === value).map(record => ({ id: record.id, data: () => record }));
          return { docs };
        } };
      } };
    },
  };
}

test('household reference input is normalized and rejects arbitrary document identifiers', () => {
  assert.equal(normalizeHouseholdDisplayId('hh-00012'), 'HH-00012');
  assert.equal(normalizeHouseholdDisplayId('H-private-doc-id'), null);
  assert.equal(normalizeHouseholdDisplayId('HH-12'), null);
});

test('household reference resolution returns only a same-barangay internal route key', async () => {
  const db = memoryFirestore([
    { id: 'secret-internal-a', displayId: 'HH-00012', barangayId: 'wawa', street: 'private' },
    { id: 'secret-internal-b', displayId: 'HH-00012', barangayId: 'borol_1st', street: 'private' },
  ]);
  const result = await findHouseholdByDisplayId(db, 'HH-00012', 'borol_1st');
  assert.deepEqual(result, { kind: 'found', id: 'secret-internal-b' });
  assert.equal(Object.hasOwn(result, 'street'), false);
});

test('missing and duplicate local household references are reported without returning another area record', async () => {
  assert.deepEqual(await findHouseholdByDisplayId(memoryFirestore([
    { id: 'other-area', displayId: 'HH-00012', barangayId: 'wawa' },
  ]), 'HH-00012', 'borol_1st'), { kind: 'missing' });
  assert.deepEqual(await findHouseholdByDisplayId(memoryFirestore([
    { id: 'a', displayId: 'HH-00012', barangayId: 'borol_1st' },
    { id: 'b', displayId: 'HH-00012', barangayId: 'borol_1st' },
  ]), 'HH-00012', 'borol_1st'), { kind: 'duplicate' });
});
