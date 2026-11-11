import type { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';

export const displayIdPrefixes = {
  reports: 'RP-',
  households: 'HH-',
  evacuationCenters: 'EVC',
  alerts: 'ALT',
  users: 'ACC-',
  accessRequests: 'ACR',
} as const;

export type DisplayIdModule = keyof typeof displayIdPrefixes;

export function displayIdDigits(module: DisplayIdModule) {
  return module === 'reports' || module === 'households' || module === 'users' ? 5 : 4;
}

export async function allocateDisplayId(transaction: Transaction, db: Firestore, module: DisplayIdModule) {
  const prefix = displayIdPrefixes[module];
  const counterRef = db.doc(`recordIdCounters/${module}`);
  const snapshot = await transaction.get(counterRef);
  const previous = snapshot.exists ? snapshot.data()?.lastIssued : 0;
  if (typeof previous !== 'number' || !Number.isSafeInteger(previous) || previous < 0) {
    throw new Error(`The ${module} display ID counter is invalid; refusing to reset it.`);
  }
  const lastIssued = previous;
  if (lastIssued >= Number.MAX_SAFE_INTEGER) throw new Error(`The ${module} display ID counter is exhausted.`);

  const next = lastIssued + 1;
  transaction.set(counterRef, { prefix, lastIssued: next, updatedAt: new Date() }, { merge: true });
  return `${prefix}${String(next).padStart(displayIdDigits(module), '0')}`;
}

export async function assignDisplayIdIfMissing(db: Firestore, module: DisplayIdModule, recordRef: DocumentReference) {
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(recordRef);
    if (!snapshot.exists) return null;
    const existing = snapshot.data()?.displayId;
    if (typeof existing === 'string' && existing.trim()) return existing;
    const displayId = await allocateDisplayId(transaction, db, module);
    transaction.update(recordRef, { displayId });
    return displayId;
  });
}
