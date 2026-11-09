const assert = require('node:assert/strict');
const { test } = require('node:test');

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db: {} } };
const { createActivityRecorder } = require('../dist/services/activityTracking');

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
