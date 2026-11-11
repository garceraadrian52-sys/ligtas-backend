const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createDisplayIdMigrationPlan } = require('../dist/services/recordDisplayIdMigration');

test('report migration preserves numeric legacy references, resolves duplicates, and sorts deterministically', () => {
  const plan = createDisplayIdMigrationPlan('reports', [
    { id: 'doc-d' },
    { id: 'doc-c', displayId: 'RP-00009' },
    { id: 'doc-a', displayId: 'RPT0007' },
    { id: 'doc-b', displayId: 'RP-00009' },
  ], 11);

  assert.deepEqual(plan.recordIds, ['doc-a', 'doc-b', 'doc-c', 'doc-d']);
  assert.deepEqual(plan.assignments, [
    { id: 'doc-a', previousDisplayId: 'RPT0007', displayId: 'RP-00007' },
    { id: 'doc-c', previousDisplayId: 'RP-00009', displayId: 'RP-00012' },
    { id: 'doc-d', previousDisplayId: null, displayId: 'RP-00013' },
  ]);
  assert.deepEqual(plan.duplicateIds, [{ displayId: 'RP-00009', keptRecordId: 'doc-b', reassignedRecordId: 'doc-c' }]);
  assert.equal(plan.lastIssued, 13);
});

test('re-running a completed report plan is idempotent', () => {
  const records = [
    { id: 'doc-a', displayId: 'RP-00007' },
    { id: 'doc-b', displayId: 'RP-00009' },
    { id: 'doc-c', displayId: 'RP-00012' },
    { id: 'doc-d', displayId: 'RP-00013' },
  ];
  const plan = createDisplayIdMigrationPlan('reports', records, 13);
  assert.equal(plan.assignments.length, 0);
  assert.equal(plan.lastIssued, 13);
});

test('household migration adds padded references and keeps the greatest prior counter', () => {
  const plan = createDisplayIdMigrationPlan('households', [
    { id: 'household-b', displayId: 'HH-00021' },
    { id: 'household-a', displayId: 'H-LEGACY' },
  ], 18);
  assert.deepEqual(plan.assignments, [
    { id: 'household-a', previousDisplayId: 'H-LEGACY', displayId: 'HH-00022' },
  ]);
  assert.equal(plan.lastIssued, 22);
});

test('migration refuses corrupt counters instead of reusing numbers', () => {
  assert.throws(() => createDisplayIdMigrationPlan('households', [], 'reset'), /refusing to reset/i);
});
