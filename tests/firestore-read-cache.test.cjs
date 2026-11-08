const assert = require('node:assert/strict');
const { test } = require('node:test');
const { cachedFirestoreRead, invalidateFirestoreReadCache } = require('../dist/services/firestoreReadCache');

test('identical concurrent Firestore reads share one in-flight load and a brief cached result', async () => {
  let calls = 0;
  let resolveLoad;
  const load = () => {
    calls++;
    return new Promise(resolve => { resolveLoad = resolve; });
  };

  const first = cachedFirestoreRead('test:shared', load, 1000);
  const second = cachedFirestoreRead('test:shared', load, 1000);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  resolveLoad([{ id: 'one' }]);
  assert.deepEqual(await Promise.all([first, second]), [[{ id: 'one' }], [{ id: 'one' }]]);

  const cached = await cachedFirestoreRead('test:shared', async () => {
    calls++;
    return [];
  }, 1000);
  assert.deepEqual(cached, [{ id: 'one' }]);
  assert.equal(calls, 1);
});

test('prefix invalidation forces a new read and prevents an older in-flight result from being cached', async () => {
  let calls = 0;
  let resolveOld;
  const oldRead = cachedFirestoreRead('reports:all', () => {
    calls++;
    return new Promise(resolve => { resolveOld = resolve; });
  });
  await Promise.resolve();
  invalidateFirestoreReadCache('reports:');
  resolveOld(['old']);
  assert.deepEqual(await oldRead, ['old']);

  const fresh = await cachedFirestoreRead('reports:all', async () => {
    calls++;
    return ['fresh'];
  });
  assert.deepEqual(fresh, ['fresh']);
  assert.equal(calls, 2);
});

test('failed Firestore reads are not cached', async () => {
  let calls = 0;
  const load = async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('busy'), { code: 8 });
    return ['available'];
  };

  await assert.rejects(cachedFirestoreRead('test:failure', load), { code: 8 });
  assert.deepEqual(await cachedFirestoreRead('test:failure', load), ['available']);
  assert.equal(calls, 2);
});

test('successful read entries expire after their configured TTL', async () => {
  let calls = 0;
  const load = async () => ++calls;

  assert.equal(await cachedFirestoreRead('test:ttl', load, 10), 1);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(await cachedFirestoreRead('test:ttl', load, 10), 2);
  assert.equal(calls, 2);
});
