const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const express = require('express');

let role = 'SUPER_ADMIN';
let center = {
  id: 'balagtas-gym', name: 'Balagtas Gym', address: 'Town Plaza', barangayId: 'barangay_longos',
  latitude: 14.8187, longitude: 120.9054, capacity: 19800, maxCapacity: 19800,
  occupied: 0, currentOccupancy: 0, facilities: ['Restrooms'], contactPerson: 'Old contact',
  contactNumber: '09170000000', status: 'OPEN', displayId: 'EVC0001', updatedAt: new Date('2026-11-09T00:00:00.000Z'),
};
let audit = [];
let auditSequence = 0;
const centerRef = { id: center.id, path: `evacuationCenters/${center.id}` };

const db = {
  doc(path) {
    if (path.startsWith('barangays/')) return { path, async get() { return { exists: path === 'barangays/barangay_longos' }; } };
    if (path === centerRef.path) return centerRef;
    throw new Error(`Unexpected document path ${path}`);
  },
  collection(name) {
    if (name === 'auditLogs') return { doc() { const id = `audit-${++auditSequence}`; return { id, path: `auditLogs/${id}` }; } };
    throw new Error(`Unexpected collection ${name}`);
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      async get(reference) {
        if (reference.path !== centerRef.path) throw new Error(`Unexpected transaction read ${reference.path}`);
        return { id: center.id, exists: Boolean(center), data: () => ({ ...center }) };
      },
      update(reference, values) { writes.push({ kind: 'update', reference, values }); },
      create(reference, values) { writes.push({ kind: 'create', reference, values }); },
    };
    const result = await callback(transaction);
    for (const write of writes) {
      if (write.kind === 'update' && write.reference.path === centerRef.path) center = { ...center, ...write.values };
      if (write.kind === 'create' && write.reference.path.startsWith('auditLogs/')) audit.push({ id: write.reference.id, ...write.values });
    }
    return result;
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) { req.user = { uid: 'super-uid', role, name: 'Super Admin', email: 'admin@example.com' }; next(); },
    requireOfficial(_req, _res, next) { next(); },
  },
};
require.cache[require.resolve('../dist/services/auditLog')] = {
  exports: {
    logActionInTransaction(transaction, params) {
      const reference = db.collection('auditLogs').doc();
      transaction.create(reference, { ...params, timestamp: new Date() });
      return reference;
    },
  },
};
require.cache[require.resolve('../dist/services/firestoreReadCache')] = { exports: { invalidateFirestoreReadCache() {} } };

const app = express();
app.use(express.json());
app.use('/evacuation-centers', require('../dist/routes/evacuationCenters').default);
let server;
let base;
before(async () => {
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}/evacuation-centers/${center.id}`;
});
after(() => { server.closeAllConnections(); server.close(); });

function body(overrides = {}) {
  return {
    name: 'Balagtas Gym', address: 'Town Plaza', barangayId: 'barangay_longos',
    latitude: 14.8187, longitude: 120.9054, capacity: 20000, facilities: ['Restrooms'],
    contactPerson: 'New contact', contactNumber: '09171112222', status: 'OPEN',
    expectedUpdatedAt: center.updatedAt.toISOString(), ...overrides,
  };
}

async function patchCenter(values = {}) {
  return fetch(base, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body(values)),
  });
}

beforeEach(() => {
  role = 'SUPER_ADMIN';
  center = {
    id: 'balagtas-gym', name: 'Balagtas Gym', address: 'Town Plaza', barangayId: 'barangay_longos',
    latitude: 14.8187, longitude: 120.9054, capacity: 19800, maxCapacity: 19800,
    occupied: 0, currentOccupancy: 0, facilities: ['Restrooms'], contactPerson: 'Old contact',
    contactNumber: '09170000000', status: 'OPEN', displayId: 'EVC0001', updatedAt: new Date('2026-11-09T00:00:00.000Z'),
  };
  audit = [];
});

test('only Super Admin can edit a center', async () => {
  role = 'LGU_ADMIN';
  const response = await patchCenter();
  assert.equal(response.status, 403);
  assert.equal(center.capacity, 19800);
  assert.equal(audit.length, 0);
});

test('Super Admin edits canonical center fields atomically, preserving the document ID and auditing changes', async () => {
  const response = await patchCenter({ capacity: 20000, contactNumber: '09173334444' });
  const { data } = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.id, 'balagtas-gym');
  assert.equal(data.capacity, 20000);
  assert.equal(data.maxCapacity, 20000);
  assert.equal(data.occupied, 0);
  assert.equal(center.capacity, 20000);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorId, 'super-uid');
  assert.equal(audit[0].targetId, 'balagtas-gym');
  assert.ok(audit[0].details.changedFields.includes('capacity'));
  assert.deepEqual(audit[0].details.before.capacity, 19800);
  assert.deepEqual(audit[0].details.after.capacity, 20000);
  assert.deepEqual(audit[0].details.before.contactNumber, '[redacted]');
  assert.deepEqual(audit[0].details.after.contactNumber, '[redacted]');
});

test('capacity below current occupancy is rejected without changing center or audit data', async () => {
  center = { ...center, occupied: 2, currentOccupancy: 2 };
  const response = await patchCenter({ capacity: 1 });
  assert.equal(response.status, 409);
  assert.equal(center.capacity, 19800);
  assert.equal(audit.length, 0);
});

test('closing a center with checked-in occupants and stale edits are rejected', async () => {
  center = { ...center, occupied: 1, currentOccupancy: 1 };
  const closeResponse = await patchCenter({ status: 'CLOSED' });
  assert.equal(closeResponse.status, 409);
  assert.equal(center.status, 'OPEN');
  assert.equal(audit.length, 0);

  center = { ...center, updatedAt: new Date('2026-11-10T00:00:00.000Z') };
  const staleResponse = await patchCenter({ expectedUpdatedAt: '2026-11-09T00:00:00.000Z' });
  assert.equal(staleResponse.status, 409);
  assert.equal(audit.length, 0);
});

test('invalid status and unsafe capacity are rejected', async () => {
  const invalidStatus = await patchCenter({ status: 'NEARLY_FULL' });
  assert.equal(invalidStatus.status, 400);
  const invalidCapacity = await patchCenter({ capacity: Number.MAX_SAFE_INTEGER + 1 });
  assert.equal(invalidCapacity.status, 400);
  assert.equal(audit.length, 0);
});
