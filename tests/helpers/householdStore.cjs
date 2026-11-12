function householdStore() {
  const records = new Map();
  let sequence = 0;
  let tail = Promise.resolve();
  const snapshot = path => ({ id: path.split('/').at(-1), ref: db.doc(path), exists: records.has(path), data: () => records.get(path) });
  const queryResult = query => {
    const docs = [...records.keys()].filter(path => path.split('/').length === 2 && path.startsWith(query.collection + '/'))
      .filter(path => query.filters.every(([field, operator, value]) => operator === 'array-contains'
        ? records.get(path)[field]?.includes(value) : records.get(path)[field] === value)).map(snapshot);
    return { docs, size: docs.length, empty: !docs.length };
  };
  const db = {
    doc(path) { return { path, id: path.split('/').at(-1), get: async () => snapshot(path) }; },
    collection(name) {
      const query = { collection: name, filters: [],
        where(field, operator, value) { return { ...this, filters: [...this.filters, [field, operator, value]] }; },
        get() { return Promise.resolve(queryResult(this)); },
        doc(id = `auto${String(++sequence).padStart(10, '0')}`) { return db.doc(`${name}/${id}`); },
      };
      return query;
    },
    async runTransaction(callback) {
      const previous = tail;
      let release;
      tail = new Promise(resolve => { release = resolve; });
      await previous;
      const writes = [];
      const transaction = {
        async get(ref) {
          if (writes.length) throw new Error('Firestore transactions must read before writing.');
          return ref.collection ? queryResult(ref) : snapshot(ref.path);
        },
        create(ref, data) { if (records.has(ref.path)) throw new Error('Document exists'); writes.push([ref.path, data]); },
        update(ref, data) { if (!records.has(ref.path)) throw new Error('Missing document'); writes.push([ref.path, { ...records.get(ref.path), ...data }]); },
        set(ref, data, options) { writes.push([ref.path, options?.merge ? { ...records.get(ref.path), ...data } : data]); },
      };
      try {
        const result = await callback(transaction);
        for (const [path, data] of writes) records.set(path, data);
        return result;
      } finally { release(); }
    },
  };
  const household = { name: 'Dela Cruz', head: 'Juan Dela Cruz', createdBy: 'juan', street: 'Private address', contact: '9123456789',
    barangayId: 'wawa', displayId: 'HH-00001', memberUids: ['juan'],
    members: [{ id: 'head', userId: 'juan', name: 'Juan Dela Cruz', relationship: 'Head' },
      { id: 'manual-maria', name: 'Maria Dela Cruz', relationship: 'Wife' },
      { id: 'manual-ana', name: 'Ana Dela Cruz', relationship: 'Daughter' }] };
  records.set('households/H-DELACRUZ', household);
  for (const [uid, name] of [['juan', 'Juan Dela Cruz'], ['maria', 'Maria Registered Name'], ['ana', 'Ana Dela Cruz'], ['other', 'Another resident']]) {
    records.set(`users/${uid}`, { role: 'RESIDENT', name, barangayId: 'wawa', householdId: uid === 'juan' ? 'H-DELACRUZ' : null,
      ...(uid === 'juan' ? { householdMemberId: 'head' } : {}) });
  }
  records.set('barangays/wawa', { name: 'Wawa' });
  return { db, records, household };
}
module.exports = { householdStore };
