const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const policy = require('../dist/services/notificationPolicy');

test('a newly published barangay alert queues one eligible device delivery and deduplicates edits', async () => {
  const callbacks = new Map();
  const jobs = new Map();
  const profiles = [
    { id: 'super-admin', data: () => ({ role: 'SUPER_ADMIN', barangayId: null }) },
    { id: 'resident-dalig', data: () => ({ role: 'RESIDENT', barangayId: 'barangay_dalig' }) },
    { id: 'resident-wawa', data: () => ({ role: 'RESIDENT', barangayId: 'barangay_wawa' }) },
  ];
  const administrators = [{ id: 'super-admin', data: () => ({ role: 'SUPER_ADMIN' }) }];
  const devicesByPath = new Map(profiles.map(user => [
    `users/${user.id}/devices/phone`, [{ ref: { path: `users/${user.id}/devices/phone` } }],
  ]));

  function collection(name) {
    let adminRoleQuery = false;
    const query = {
      onSnapshot(callback) { callbacks.set(name, callback); },
      where(field, operator) { if (name === 'users' && field === 'role' && operator === 'in') adminRoleQuery = true; return this; }, orderBy() { return this; }, limit() { return this; }, startAfter() { return this; },
      async get() {
        if (name === 'users' && adminRoleQuery) return { docs: administrators, size: administrators.length };
        if (name === 'users') return { docs: profiles, size: profiles.length };
        if (name.startsWith('users/') && name.endsWith('/devices')) {
          const docs = devicesByPath.get(`${name}/phone`) || [];
          return { docs, size: docs.length };
        }
        return { docs: [], size: 0 };
      },
      doc(id) {
        const path = `${name}/${id}`;
        return {
          id, path,
          async create(data) {
            if (jobs.has(id)) throw Object.assign(new Error('Already exists'), { code: 'already-exists' });
            jobs.set(id, data);
          },
          async get() { return { data: () => jobs.get(id) }; },
        };
      },
    };
    return query;
  }

  const db = { collection, doc: path => ({ path, id: path.split('/').at(-1) }) };
  const exports = {};
  vm.runInNewContext(readFileSync(require.resolve('../dist/services/notificationWorker'), 'utf8'), {
    exports, setInterval: () => 0, console: { log() {}, error() {} }, Date,
    require: name => name === 'node:crypto' ? require(name)
      : name.includes('firebaseAdmin') ? { db }
        : name.includes('notificationPolicy') ? policy
          : name.includes('roles') ? require('../dist/services/roles')
          : name.includes('recordDisplayIds') ? { assignDisplayIdIfMissing: async () => null }
            : name === 'firebase-admin/firestore' ? {
              Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: value => ({ toMillis: () => value }) },
              FieldValue: { delete: () => null },
            } : null,
  });

  exports.startNotificationWorkers();
  const publishedAt = new Date();
  const recoveredAlert = {
    id: 'recent-alert-id', ref: { path: 'alerts/recent-alert-id' },
    data: () => ({ displayId: 'ALT0001', status: 'active', category: 'Flood Warning', title: 'Recent alert',
      message: 'Recent publication recovery', coverageArea: 'barangay', barangayId: 'barangay_dalig', publishedAt: new Date() }),
  };
  await callbacks.get('alerts')({ docs: [recoveredAlert], size: 1, docChanges: () => [{ type: 'added', doc: recoveredAlert }] });
  assert.equal(jobs.size, 3);
  const alert = {
    id: 'firestore-alert-id', ref: { path: 'alerts/firestore-alert-id' },
    data: () => ({ displayId: 'ALT0001', status: 'published', category: 'Flood Warning', title: 'Flooding',
      message: 'Water is rising', coverageArea: 'barangay', barangayId: 'barangay_dalig', publishedAt }),
  };
  const draft = { ...alert, data: () => ({ ...alert.data(), status: 'draft', publishedAt: null }) };
  await callbacks.get('alerts')({ docs: [draft], size: 1, docChanges: () => [{ type: 'added', doc: draft }] });
  await callbacks.get('alerts')({ docs: [draft], size: 1, docChanges: () => [{ type: 'modified', doc: draft }] });
  assert.equal(jobs.size, 3, 'draft creation and editing must queue no inbox or push delivery');
  const added = { docs: [alert], size: 1, docChanges: () => [{ type: 'added', doc: alert }] };
  await callbacks.get('alerts')(added);
  await callbacks.get('alerts')({ docs: [alert], size: 1, docChanges: () => [{ type: 'modified', doc: alert }] });

  assert.equal(jobs.size, 6);
  const delivery = [...jobs.values()].find(job => job.state === 'pending' && job.userId === 'resident-dalig' && job.targetId === 'firestore-alert-id');
  assert.equal(delivery.userId, 'resident-dalig');
  assert.equal(delivery.targetId, 'firestore-alert-id');
  assert.equal(delivery.title, 'Flooding');
  const inbox = [...jobs.values()].filter(job => job.state === 'inbox');
  assert.equal(inbox.length, 2);
  assert.ok(inbox.every(job => job.userId === 'super-admin' && job.targetPath === '/Alerts_Management'));
});

test('Super Admin receives municipality scoped alert eligibility', () => {
  assert.equal(policy.inArea({ coverageArea: 'barangay', barangayId: 'barangay_dalig' }, { role: 'SUPER_ADMIN', barangayId: null }), true);
});
