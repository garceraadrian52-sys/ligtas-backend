const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

test('household delivery rejects stale attempts even when the status becomes identical again', () => {
  const { householdDeliveryCurrent } = require('../dist/services/notificationPolicy');
  const job = { userId: 'resident', expectedStatus: 'Approved', expectedRevision: 1 };
  const current = { userId: 'resident', status: 'Approved', revision: 2 };
  assert.equal(householdDeliveryCurrent(job, current), false);
  assert.equal(householdDeliveryCurrent({ ...job, expectedRevision: 2 }, current), true);
  assert.equal(householdDeliveryCurrent({ ...job, expectedRevision: 2 }, { ...current, userId: 'other' }), false);
  assert.equal(householdDeliveryCurrent({ ...job, expectedRevision: 2 }, { ...current, status: 'Pending' }), false);
  assert.equal(householdDeliveryCurrent({ userId: 'resident', expectedStatus: 'Approved' }, { userId: 'resident', status: 'Approved' }), true);
});

test('household notifications retain the reviewed revision, deduplicate retries and notify a new decision', async () => {
  const callbacks = new Map(), jobs = new Map();
  const doc = path => ({ path, id: path.split('/').at(-1), onSnapshot: callback => callbacks.set(path, callback),
    get: async () => ({ data: () => ({ role: 'RESIDENT' }) }) });
  const collection = name => ({
    where() { return this; }, orderBy() { return this; }, limit() { return this; }, startAfter() { return this; },
    onSnapshot(callback) { callbacks.set(name, callback); },
    async get() { const docs = name === 'users/resident/devices' ? [{ ref: doc(name + '/phone') }] : []; return { docs, size: docs.length }; },
    doc(id) { return { ...doc(name + '/' + id),
      async create(data) { if (jobs.has(id)) throw Object.assign(new Error('Exists'), { code: 6 }); jobs.set(id, data); },
      async get() { return { data: () => jobs.get(id) }; },
    }; },
  });
  const exports = {};
  vm.runInNewContext(readFileSync(require.resolve('../dist/services/notificationWorker'), 'utf8'), {
    exports, setInterval: () => 0, Date, console: { log() {}, error() {} },
    require: name => name === 'node:crypto' ? require(name)
      : name.includes('firebaseAdmin') ? { db: { collection, doc } }
        : name.includes('notificationPolicy') ? require('../dist/services/notificationPolicy')
          : name.includes('roles') ? require('../dist/services/roles')
            : name.includes('recordDisplayIds') ? { assignDisplayIdIfMissing: async () => null }
              : name === 'firebase-admin/firestore' ? {
                Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: value => ({ toMillis: () => value }) },
                FieldValue: { delete: () => null },
              } : null,
  });
  exports.startNotificationWorkers();
  const listener = callbacks.get('householdRequests');
  await listener({ docs: [], size: 0 });
  const change = (revision, status = 'Rejected') => ({ docs: [], size: 1, docChanges: () => [{ type: 'modified', doc: {
    id: 'stable-request', ref: { path: 'householdRequests/stable-request' },
    data: () => ({ userId: 'resident', householdId: 'H-ABCDE', revision, status, decidedByName: 'Reviewed Head' }),
  } }] });
  await listener(change(1));
  await listener(change(1));
  assert.equal(jobs.size, 1);
  assert.equal([...jobs.values()][0].expectedRevision, 1);
  assert.match([...jobs.values()][0].body, /Reviewed Head/);
  // The listener can miss a short Pending state; revision still distinguishes attempts.
  await listener(change(2));
  assert.equal(jobs.size, 2);
  assert.deepEqual([...jobs.values()].map(job => job.expectedRevision), [1, 2]);
});
