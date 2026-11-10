const assert = require('node:assert/strict');
const { test } = require('node:test');

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db: {} } };
const { createActivityRecorder, ACTIVITY_TRACKED_ROLES, shouldTrackAuthenticatedActivity } = require('../dist/services/activityTracking');

test('activity tracking includes every supported web and mobile account role', () => {
  assert.deepEqual([...ACTIVITY_TRACKED_ROLES], ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT']);
  for (const role of ACTIVITY_TRACKED_ROLES) assert.equal(shouldTrackAuthenticatedActivity(role), true, role);
  assert.equal(shouldTrackAuthenticatedActivity(''), false);
});

test('authenticated activity writes are throttled and login time is derived from verified auth_time', async () => {
  let now = 10_000;
  const writes = [];
  const record = createActivityRecorder(async (uid, updates) => writes.push({ uid, updates }), 1_000, () => now);

  assert.equal(await record('user-1', 8), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].uid, 'user-1');
  assert.ok(writes[0].updates.lastActiveAt);
  assert.equal(writes[0].updates.lastLoginAt.toMillis(), 8_000);

  now += 500;
  assert.equal(await record('user-1', 8), false);
  assert.equal(writes.length, 1);

  now += 500;
  assert.equal(await record('user-1', 8), true);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].updates.lastActiveAt);
  assert.equal(writes[1].updates.lastLoginAt, undefined);

  now += 100;
  assert.equal(await record('user-1', 9), true);
  assert.equal(writes.length, 3);
  assert.equal(writes[2].updates.lastActiveAt, undefined);
  assert.equal(writes[2].updates.lastLoginAt.toMillis(), 9_000);
});

test('login-only recording never marks passive API requests as Last Active', async () => {
  let now = 10_000;
  const writes = [];
  const record = createActivityRecorder(async (uid, updates) => writes.push({ uid, updates }), 1_000, () => now);

  assert.equal(await record('user-1', 8, false), true);
  assert.deepEqual(Object.keys(writes[0].updates), ['lastLoginAt']);
  assert.equal(writes[0].updates.lastLoginAt.toMillis(), 8_000);
  assert.equal(await record('user-1', 8, false), false);
  assert.equal(writes.length, 1);

  assert.equal(await record('user-1', 8, true), true);
  assert.ok(writes[1].updates.lastActiveAt);
  assert.equal(writes[1].updates.lastLoginAt, undefined);
});
