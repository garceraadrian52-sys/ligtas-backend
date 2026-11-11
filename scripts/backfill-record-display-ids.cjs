const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MIGRATION_CONFIRMATION = 'assign-record-display-ids';
const MODULES = ['reports', 'households'];
const hash = value => createHash('sha256').update(value).digest('hex');
const projectIdOf = app => app.options.projectId || process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
const readCounter = snapshot => snapshot.exists ? snapshot.data()?.lastIssued : 0;

function isAbsoluteOption(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return value;
}

function migrationIdFor(module, plan) {
  return hash(JSON.stringify({ module, counterBase: plan.counterBase, lastIssued: plan.lastIssued, recordIds: plan.recordIds, assignments: plan.assignments }));
}

function writeBackup(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) return;
  fs.writeFileSync(filePath, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, { flag: 'wx' });
}

async function fetchCollection(db, module) {
  const [records, counter] = await Promise.all([
    db.collection(module).get(),
    db.doc(`recordIdCounters/${module}`).get(),
  ]);
  return { records, counter };
}

function requireSameRecordSet(snapshot, plan) {
  const ids = snapshot.docs.map(doc => doc.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(plan.recordIds)) {
    throw new Error(`The ${plan.module} collection changed after the dry run. Create a new plan before applying.`);
  }
}

async function run() {
  require('dotenv/config');
  const firebaseAdmin = require('../dist/config/firebaseAdmin');
  const { createDisplayIdMigrationPlan } = require('../dist/services/recordDisplayIdMigration');
  const { db } = firebaseAdmin;
  const apply = process.argv.includes('--apply');
  const projectArg = process.argv.find(value => value.startsWith('--project-id='))?.slice('--project-id='.length);
  const confirmation = process.argv.find(value => value.startsWith('--confirm='))?.slice('--confirm='.length);
  const planFileArg = process.argv.find(value => value.startsWith('--plan-file='))?.slice('--plan-file='.length);
  const backupDirArg = process.argv.find(value => value.startsWith('--backup-dir='))?.slice('--backup-dir='.length);
  const moduleArg = process.argv.find(value => value.startsWith('--modules='))?.slice('--modules='.length);
  const planFile = isAbsoluteOption(planFileArg, '--plan-file');
  const actualProjectId = projectIdOf(firebaseAdmin.default);
  const modules = moduleArg ? moduleArg.split(',').map(value => value.trim()).filter(Boolean) : MODULES;
  if (modules.some(module => !MODULES.includes(module))) throw new Error('--modules accepts only reports and households.');
  if (new Set(modules).size !== modules.length) throw new Error('--modules contains a duplicate collection.');

  if (!apply) {
    const plans = {};
    for (const module of modules) {
      const { records, counter } = await fetchCollection(db, module);
      const data = records.docs.map(doc => ({ id: doc.id, displayId: doc.data().displayId }));
      const plan = createDisplayIdMigrationPlan(module, data, readCounter(counter));
      plans[module] = { ...plan, migrationId: migrationIdFor(module, plan) };
      console.log(`[dry-run] ${module}: ${records.size} record(s), ${plan.assignments.length} assignment(s), ${plan.duplicateIds.length} duplicate(s), counter ${plan.counterBase} -> ${plan.lastIssued}`);
    }
    fs.mkdirSync(path.dirname(planFile), { recursive: true });
    fs.writeFileSync(planFile, `${JSON.stringify({ version: 1, projectId: actualProjectId, createdAt: new Date().toISOString(), plans }, null, 2)}\n`, { flag: 'wx' });
    console.log(`[dry-run] Saved resumable plan to ${planFile}. No Firestore records were changed.`);
    return;
  }

  const backupDir = isAbsoluteOption(backupDirArg, '--backup-dir');
  if (confirmation !== MIGRATION_CONFIRMATION || !projectArg || projectArg !== actualProjectId) {
    throw new Error(`Apply requires --confirm=${MIGRATION_CONFIRMATION} and a matching --project-id=<Firebase project>.`);
  }
  const saved = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  if (saved.version !== 1 || saved.projectId !== actualProjectId || !saved.plans) throw new Error('The migration plan is for a different project or unsupported version.');

  for (const module of modules) {
    const plan = saved.plans[module];
    if (!plan || plan.module !== module || plan.migrationId !== migrationIdFor(module, plan)) throw new Error(`The saved ${module} plan is missing or was changed.`);
    const { records, counter } = await fetchCollection(db, module);
    requireSameRecordSet(records, plan);
    const dataById = new Map(records.docs.map(doc => [doc.id, doc.data()]));
    for (const assignment of plan.assignments) {
      const current = dataById.get(assignment.id)?.displayId;
      if ((typeof current === 'string' && current.trim() ? current.trim() : null) !== assignment.previousDisplayId && current !== assignment.displayId) {
        throw new Error(`Record ${assignment.id} changed after the dry run. Create a new plan before applying.`);
      }
    }

    const backupLines = records.docs.filter(doc => plan.assignments.some(item => item.id === doc.id)).map(doc => ({ path: `${module}/${doc.id}`, data: doc.data() }));
    backupLines.push({ path: `recordIdCounters/${module}`, exists: counter.exists, data: counter.exists ? counter.data() : null });
    const backupPath = path.join(backupDir, `${module}-${plan.migrationId}.jsonl`);
    writeBackup(backupPath, backupLines);

    const counterRef = db.doc(`recordIdCounters/${module}`);
    const migrationRef = db.doc(`recordIdMigrations/${plan.migrationId}`);
    await db.runTransaction(async transaction => {
      const [migration, currentCounter] = await Promise.all([transaction.get(migrationRef), transaction.get(counterRef)]);
      if (migration.exists) {
        if (migration.data()?.planId !== plan.migrationId || migration.data()?.module !== module) throw new Error(`Migration marker collision for ${module}.`);
        return;
      }
      const lastIssued = readCounter(currentCounter);
      if (lastIssued !== plan.counterBase) throw new Error(`The ${module} counter changed after the dry run. Create a new plan before applying.`);
      transaction.set(counterRef, { prefix: module === 'reports' ? 'RP-' : 'HH-', lastIssued: plan.lastIssued, updatedAt: new Date() }, { merge: true });
      transaction.create(migrationRef, { planId: plan.migrationId, module, state: 'reserved', lastIssued: plan.lastIssued, updatedAt: new Date() });
    });

    let completed = 0;
    for (let start = 0; start < plan.assignments.length; start += 400) {
      const chunk = plan.assignments.slice(start, start + 400);
      const currentDocs = await Promise.all(chunk.map(item => db.doc(`${module}/${item.id}`).get()));
      const batch = db.batch();
      let writes = 0;
      currentDocs.forEach((snapshot, index) => {
        const assignment = chunk[index];
        if (!snapshot.exists) throw new Error(`Record ${assignment.id} disappeared during migration.`);
        const current = snapshot.data()?.displayId;
        if (current === assignment.displayId) return;
        const normalized = typeof current === 'string' && current.trim() ? current.trim() : null;
        if (normalized !== assignment.previousDisplayId) throw new Error(`Record ${assignment.id} changed during migration; the current data was left intact.`);
        batch.update(snapshot.ref, { displayId: assignment.displayId });
        writes += 1;
      });
      if (writes) await batch.commit();
      completed += chunk.length;
      console.log(`[apply] ${module}: ${completed}/${plan.assignments.length} planned assignment(s) checked.`);
    }
    await migrationRef.set({ state: 'complete', completedAt: new Date() }, { merge: true });
    console.log(`[apply] ${module}: done. Backup: ${backupPath}`);
  }
}

run().catch(error => {
  console.error('Record display ID migration stopped:', error instanceof Error ? error.message : 'Unexpected migration error.');
  process.exitCode = 1;
});
