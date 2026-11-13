const { householdStore } = require('./householdStore.cjs');
const boundaries = require('../../src/config/barangayBoundaries.json');
function reportStore() {
  const { db, records } = householdStore();
  for (const feature of boundaries.features) records.set('barangays/' + feature.properties.id, { name: feature.properties.name });
  for (const [uid, role, area] of [['reporter','RESIDENT','barangay_borol_1st'], ['boWawa','BARANGAY_OFFICIAL','barangay_wawa'], ['boBorol','BARANGAY_OFFICIAL','barangay_borol_1st'], ['admin','LGU_ADMIN',null]]) records.set('users/' + uid, { role, barangayId: area, name: uid });
  const run = db.runTransaction.bind(db);
  db.runTransaction = callback => run(tx => callback({ ...tx, get: async ref => { const snapshot = await tx.get(ref); return { ...snapshot, get: field => snapshot.data()?.[field] }; } }));
  return { db, records };
}
module.exports = { reportStore };
