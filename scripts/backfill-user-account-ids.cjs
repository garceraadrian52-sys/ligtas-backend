const ACCOUNT_ID_PATTERN = /^ACC-(\d{5,})$/;

function accountIdNumber(value) {
  const match = typeof value === 'string' ? ACCOUNT_ID_PATTERN.exec(value.trim()) : null;
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function createBackfillPlan(users, currentCounter) {
  const rows = users.map(user => ({
    id: String(user.id),
    accountId: user.accountId,
    displayId: user.displayId,
  }));
  const ownersById = new Map();
  let maximumExisting = Number.isSafeInteger(currentCounter) && currentCounter >= 0 ? currentCounter : 0;
  for (const user of rows) {
    for (const value of [user.accountId, user.displayId]) {
      const number = accountIdNumber(value);
      if (number !== null) {
        maximumExisting = Math.max(maximumExisting, number);
      }
    }
    const effectiveId = accountIdNumber(user.accountId) !== null ? String(user.accountId).trim()
      : accountIdNumber(user.displayId) !== null ? String(user.displayId).trim() : null;
    if (effectiveId) {
      const owners = ownersById.get(effectiveId) ?? new Set();
      owners.add(user.id);
      ownersById.set(effectiveId, owners);
    }
  }

  const conflicts = [...ownersById.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([accountId]) => accountId);
  const conflictedIds = new Set(conflicts);
  const assignments = [];
  const unresolved = [];
  let next = maximumExisting;

  for (const user of rows) {
    const currentAccountId = typeof user.accountId === 'string' ? user.accountId.trim() : '';
    if (currentAccountId && accountIdNumber(currentAccountId) !== null) continue;
    if (currentAccountId) {
      unresolved.push({ id: user.id, reason: 'Existing accountId is non-empty and not in the ACC format.' });
      continue;
    }

    const legacyAccountId = accountIdNumber(user.displayId) !== null ? String(user.displayId).trim() : '';
    if (legacyAccountId) {
      if (conflictedIds.has(legacyAccountId)) {
        unresolved.push({ id: user.id, reason: `Existing displayId ${legacyAccountId} is duplicated.` });
        continue;
      }
      assignments.push({ id: user.id, accountId: legacyAccountId, source: 'existing-display-id' });
      continue;
    }

    if (next >= Number.MAX_SAFE_INTEGER) throw new Error('The user account ID counter is exhausted.');
    next += 1;
    assignments.push({ id: user.id, accountId: `ACC-${String(next).padStart(5, '0')}`, source: 'new-account-id' });
  }

  return {
    assignments,
    conflicts,
    unresolved,
    counterBase: maximumExisting,
    lastIssued: next,
    safeToApply: conflicts.length === 0,
  };
}

async function run() {
  require('dotenv/config');
  const firebaseAdmin = require('../dist/config/firebaseAdmin');
  const app = firebaseAdmin.default;
  const { db } = firebaseAdmin;
  const apply = process.argv.includes('--apply');
  const projectArg = process.argv.find(value => value.startsWith('--project-id='))?.slice('--project-id='.length);
  const confirmation = process.argv.find(value => value.startsWith('--confirm='))?.slice('--confirm='.length);
  const actualProject = app.options.projectId || process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;

  if (apply && (confirmation !== 'backfill-account-ids' || !projectArg || projectArg !== actualProject)) {
    throw new Error('Apply requires --confirm=backfill-account-ids and a matching --project-id=<Firebase project>.');
  }

  const counterRef = db.doc('recordIdCounters/users');
  const readCurrent = async () => {
    const [usersSnapshot, counterSnapshot] = await Promise.all([
      db.collection('users').get(),
      counterRef.get(),
    ]);
    const counter = counterSnapshot.exists ? counterSnapshot.data()?.lastIssued : 0;
    const users = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return { users, counter: Number.isSafeInteger(counter) && counter >= 0 ? counter : 0 };
  };

  const snapshot = await readCurrent();
  const preview = createBackfillPlan(snapshot.users, snapshot.counter);
  console.log(JSON.stringify({
    projectId: actualProject || 'not resolved',
    mode: apply ? 'apply' : 'dry-run',
    scanned: snapshot.users.length,
    accountsNeedingAccountId: preview.assignments.length,
    plannedNewIds: preview.assignments.filter(item => item.source === 'new-account-id').length,
    reusedExistingAccIds: preview.assignments.filter(item => item.source === 'existing-display-id').length,
    unresolved: preview.unresolved.length,
    duplicateIds: preview.conflicts,
    assignments: preview.assignments,
    counterLastIssued: snapshot.counter,
    plannedCounterLastIssued: preview.lastIssued,
    safeToApply: preview.safeToApply,
  }, null, 2));

  if (!apply) return;
  if (!preview.safeToApply) throw new Error('Duplicate ACC IDs exist; resolve them before applying this migration.');
  if (preview.assignments.length + 1 > 500) throw new Error('This migration exceeds the Firestore transaction write limit; split it into a reviewed migration.');

  const result = await db.runTransaction(async transaction => {
    const [usersSnapshot, counterSnapshot] = await Promise.all([
      transaction.get(db.collection('users')),
      transaction.get(counterRef),
    ]);
    const currentUsers = usersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const currentCounterValue = counterSnapshot.exists ? counterSnapshot.data()?.lastIssued : 0;
    const currentCounter = Number.isSafeInteger(currentCounterValue) && currentCounterValue >= 0 ? currentCounterValue : 0;
    const plan = createBackfillPlan(currentUsers, currentCounter);
    if (!plan.safeToApply) throw new Error('Duplicate ACC IDs appeared during the migration; no changes were written.');
    if (plan.assignments.length + 1 > 500) throw new Error('The current migration exceeds the Firestore transaction write limit.');

    for (const assignment of plan.assignments) {
      transaction.update(db.doc(`users/${assignment.id}`), { accountId: assignment.accountId });
    }
    if (plan.assignments.length > 0) {
      transaction.set(counterRef, {
        prefix: 'ACC-',
        lastIssued: Math.max(currentCounter, plan.lastIssued),
        updatedAt: new Date(),
      }, { merge: true });
    }
    return { scanned: currentUsers.length, assigned: plan.assignments.length, unresolved: plan.unresolved.length, lastIssued: Math.max(currentCounter, plan.lastIssued) };
  });
  console.log(JSON.stringify({ applied: true, ...result }, null, 2));
}

if (require.main === module) {
  run().catch(error => {
    console.error(error instanceof Error ? error.message : 'Account ID backfill failed.');
    process.exitCode = 1;
  });
}

module.exports = { accountIdNumber, createBackfillPlan };
