const assert = require('node:assert/strict');
const { test } = require('node:test');
const { allocateDisplayId, assignDisplayIdIfMissing } = require('../dist/services/recordDisplayIds');

function memoryFirestore() {
  const documents = new Map();
  let tail = Promise.resolve();
  const db = {
    doc(path) { return { path, id: path.split('/').at(-1) }; },
    async runTransaction(callback) {
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      const pending = [];
      const transaction = {
        async get(reference) {
          const value = documents.get(reference.path);
          return { exists: value !== undefined, data: () => value };
        },
        set(reference, value) { pending.push([reference.path, value]); },
        update(reference, value) {
          pending.push([reference.path, { ...documents.get(reference.path), ...value }]);
        },
      };
      try {
        const result = await callback(transaction);
        pending.forEach(([path, value]) => documents.set(path, value));
        return result;
      } finally { release(); }
    },
  };
  return { db, documents };
}

test('concurrent display ID allocations stay unique and sequential', async () => {
  const { db } = memoryFirestore();
  const ids = await Promise.all(Array.from({ length: 80 }, () =>
    db.runTransaction(transaction => allocateDisplayId(transaction, db, 'reports'))));
  assert.equal(new Set(ids).size, 80);
  assert.deepEqual([...ids].sort(), Array.from({ length: 80 }, (_, index) => `RP-${String(index + 1).padStart(5, '0')}`));
});

test('display IDs keep growing after four digits and assignment is idempotent', async () => {
  const { db, documents } = memoryFirestore();
  documents.set('recordIdCounters/reports', { lastIssued: 9999 });
  assert.equal(await db.runTransaction(transaction => allocateDisplayId(transaction, db, 'reports')), 'RP-10000');

  const ref = db.doc('reports/firestore-internal-id');
  documents.set(ref.path, { title: 'Existing report without a readable ID' });
  assert.equal(await assignDisplayIdIfMissing(db, 'reports', ref), 'RP-10001');
  assert.equal(await assignDisplayIdIfMissing(db, 'reports', ref), 'RP-10001');
  assert.equal(documents.get(ref.path).displayId, 'RP-10001');
});

test('new user account IDs use the ACC prefix, five minimum digits, and preserve the existing counter', async () => {
  const { db, documents } = memoryFirestore();
  assert.equal(await db.runTransaction(transaction => allocateDisplayId(transaction, db, 'users')), 'ACC-00001');
  documents.set('recordIdCounters/users', { lastIssued: 99999, prefix: 'USR' });
  assert.equal(await db.runTransaction(transaction => allocateDisplayId(transaction, db, 'users')), 'ACC-100000');
  assert.equal(documents.get('recordIdCounters/users').lastIssued, 100000);
});

test('household IDs use HH and stay unique under concurrent allocation', async () => {
  const { db } = memoryFirestore();
  const ids = await Promise.all(Array.from({ length: 80 }, () =>
    db.runTransaction(transaction => allocateDisplayId(transaction, db, 'households'))));
  assert.equal(new Set(ids).size, 80);
  assert.deepEqual([...ids].sort(), Array.from({ length: 80 }, (_, index) => `HH-${String(index + 1).padStart(5, '0')}`));
});

test('invalid counters fail closed instead of resetting and risking ID reuse', async () => {
  const { db, documents } = memoryFirestore();
  documents.set('recordIdCounters/reports', { lastIssued: 'bad' });
  await assert.rejects(db.runTransaction(transaction => allocateDisplayId(transaction, db, 'reports')), /refusing to reset/i);
});
