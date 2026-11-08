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
  assert.deepEqual([...ids].sort(), Array.from({ length: 80 }, (_, index) => `RPT${String(index + 1).padStart(4, '0')}`));
});

test('display IDs keep growing after four digits and assignment is idempotent', async () => {
  const { db, documents } = memoryFirestore();
  documents.set('recordIdCounters/reports', { lastIssued: 9999 });
  assert.equal(await db.runTransaction(transaction => allocateDisplayId(transaction, db, 'reports')), 'RPT10000');

  const ref = db.doc('reports/firestore-internal-id');
  documents.set(ref.path, { title: 'Existing report without a readable ID' });
  assert.equal(await assignDisplayIdIfMissing(db, 'reports', ref), 'RPT10001');
  assert.equal(await assignDisplayIdIfMissing(db, 'reports', ref), 'RPT10001');
  assert.equal(documents.get(ref.path).displayId, 'RPT10001');
});
