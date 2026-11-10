const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBackfillPlan } = require('../scripts/backfill-user-account-ids.cjs');

test('backfill preserves issued IDs and allocates after the existing counter', () => {
  const plan = createBackfillPlan([
    { id: 'legacy', displayId: 'USR0007' },
    { id: 'already-migrated', accountId: 'ACC-00025', displayId: 'ACC-00025' },
    { id: 'no-display-id' },
  ], 25);
  assert.deepEqual(plan.assignments, [
    { id: 'legacy', accountId: 'ACC-00026', source: 'new-account-id' },
    { id: 'no-display-id', accountId: 'ACC-00027', source: 'new-account-id' },
  ]);
  assert.equal(plan.lastIssued, 27);
  assert.equal(plan.safeToApply, true);
});

test('backfill reuses a valid ACC display ID without overwriting it', () => {
  const plan = createBackfillPlan([{ id: 'legacy-acc', displayId: 'ACC-00042' }], 5);
  assert.deepEqual(plan.assignments, [{ id: 'legacy-acc', accountId: 'ACC-00042', source: 'existing-display-id' }]);
  assert.equal(plan.lastIssued, 42);
});

test('backfill does not overwrite a non-empty unknown ID and flags duplicate IDs', () => {
  const plan = createBackfillPlan([
    { id: 'manual-id', accountId: 'LOCAL-77' },
    { id: 'first', accountId: 'ACC-00006' },
    { id: 'second', displayId: 'ACC-00006' },
  ], 0);
  assert.equal(plan.assignments.length, 0);
  assert.deepEqual(plan.conflicts, ['ACC-00006']);
  assert.deepEqual(plan.unresolved, [
    { id: 'manual-id', reason: 'Existing accountId is non-empty and not in the ACC format.' },
    { id: 'second', reason: 'Existing displayId ACC-00006 is duplicated.' },
  ]);
  assert.equal(plan.safeToApply, false);
});

test('backfill continues past five digits without truncation', () => {
  const plan = createBackfillPlan([{ id: 'next' }], 99999);
  assert.equal(plan.assignments[0].accountId, 'ACC-100000');
});
