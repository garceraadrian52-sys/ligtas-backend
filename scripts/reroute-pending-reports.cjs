require('dotenv').config({ quiet: true });
const { db } = require('../dist/config/firebaseAdmin');
const { reroutePendingReport } = require('../dist/services/reportRerouting');
const apply = process.argv.includes('--apply');
if (process.argv.some(arg => arg.startsWith('--') && arg !== '--apply')) throw Error('Supported option: --apply. Omit it for a read-only dry run.');
(async () => {
  try {
    const pending = await db.collection('reports').where('status', '==', 'Pending').get();
    const counts = {};
    console.log(apply ? 'Applying pending report routing corrections' : 'DRY RUN: no records will be changed');
    for (const doc of pending.docs) { const result = await reroutePendingReport(db, doc.id, apply); counts[result.status] = (counts[result.status] ?? 0) + 1; console.log(JSON.stringify(result)); }
    console.log(JSON.stringify({ counts }));
  } finally { await db.terminate(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
