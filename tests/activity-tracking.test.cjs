const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Timestamp } = require('firebase-admin/firestore');

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db: {} } };
const {
  ACTIVITY_WRITE_INTERVAL_MS,
  createActivityRecorder,
  nextLastLoginAt,
  ACTIVITY_TRACKED_ROLES,
  shouldTrackAuthenticatedActivity,
} = require('../dist/services/activityTracking');

test('activity tracking includes every supported web and mobile account role', () => {
  assert.deepEqual([...ACTIVITY_TRACKED_ROLES], ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT']);
  for (const role of ACTIVITY_TRACKED_ROLES) assert.equal(shouldTrackAuthenticatedActivity(role), true, role);
  assert.equal(shouldTrackAuthenticatedActivity(''), false);
  assert.equal(ACTIVITY_WRITE_INTERVAL_MS, 15 * 60 * 1000);
});

test('activity-only events never set Last Login and retain the 15-minute write throttle', async () => {
  let now = 10_000;
  const writes = [];
  const record = createActivityRecorder(
    async (uid, updates) => writes.push({ kind: 'activity', uid, updates }),
    async () => { throw new Error('activity events must not write login timestamps'); },
    1_000,
    () => now,
  );

  assert.equal(await record.recordActivity('user-1'), true);
  assert.deepEqual(Object.keys(writes[0].updates), ['lastActiveAt']);
  now += 999;
  assert.equal(await record.recordActivity('user-1'), false);
  now += 1;
  assert.equal(await record.recordActivity('user-1'), true);
  assert.equal(writes.length, 2);
});

test('interactive login stores verified auth_time and cannot move Last Login backward', async () => {
  let now = 10_000;
  let storedLogin = null;
  const writes = [];
  const record = createActivityRecorder(
    async (uid, updates) => writes.push({ kind: 'activity', uid, updates }),
    async (uid, authTimeSeconds, includeActivity) => {
      const updates = {};
      const next = nextLastLoginAt(storedLogin, authTimeSeconds);
      if (next) { updates.lastLoginAt = next; storedLogin = next; }
      if (includeActivity) updates.lastActiveAt = 'server timestamp';
      if (!Object.keys(updates).length) return false;
      writes.push({ kind: 'login', uid, updates });
      return true;
    },
    1_000,
    () => now,
  );

  assert.equal(await record.recordLogin('user-1', 8), true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'login');
  assert.equal(writes[0].updates.lastLoginAt.toMillis(), 8_000);
  assert.equal(writes[0].updates.lastActiveAt, 'server timestamp');

  now += 400;
  assert.equal(await record.recordLogin('user-1', 8), false);
  assert.equal(await record.recordLogin('user-1', 7), false);
  assert.equal(storedLogin.toMillis(), 8_000);
  assert.equal(writes.length, 1);

  now += 500;
  assert.equal(await record.recordLogin('user-1', 9), true);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].updates.lastLoginAt.toMillis(), 9_000);
  assert.equal(writes[1].updates.lastActiveAt, undefined);
});

test('login timestamp comparison preserves a newer stored value and rejects invalid auth_time', () => {
  const current = Timestamp.fromMillis(12_000);
  assert.equal(nextLastLoginAt(current, 11), null);
  assert.equal(nextLastLoginAt(current, 12), null);
  assert.equal(nextLastLoginAt(current, undefined), null);
  assert.equal(nextLastLoginAt(current, Number.NaN), null);
  assert.equal(nextLastLoginAt(current, 13).toMillis(), 13_000);
  assert.equal(nextLastLoginAt('invalid', 8).toMillis(), 8_000);
});

test('concurrent activity calls for one account serialize so the throttle is not bypassed', async () => {
  const writes = [];
  const record = createActivityRecorder(
    async (uid, updates) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      writes.push({ uid, updates });
    },
    async () => false,
    1_000,
    () => 10_000,
  );
  const results = await Promise.all([record.recordActivity('user-1'), record.recordActivity('user-1')]);
  assert.deepEqual(results, [true, false]);
  assert.equal(writes.length, 1);
});
