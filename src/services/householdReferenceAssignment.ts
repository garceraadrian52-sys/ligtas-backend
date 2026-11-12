import type { Firestore } from 'firebase-admin/firestore';
import { allocateDisplayId } from './recordDisplayIds';

export class HouseholdReferenceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function ensureHouseholdReference(db: Firestore, id: string, uid: string) {
  return db.runTransaction(async transaction => {
    const ref = db.doc(`households/${id}`);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new HouseholdReferenceError('Household not found.', 404);
    const household = snapshot.data()!;
    if (household.createdBy !== uid && !(Array.isArray(household.memberUids) && household.memberUids.includes(uid))) {
      throw new HouseholdReferenceError('You cannot access this household.', 403);
    }
    if (typeof household.displayId === 'string' && household.displayId.trim()) {
      if (!/^HH-\d{5,}$/.test(household.displayId)) throw new HouseholdReferenceError('Contact your barangay office to check this household reference.', 409);
      return household.displayId;
    }
    const displayId = await allocateDisplayId(transaction, db, 'households');
    transaction.update(ref, { displayId });
    return displayId;
  });
}
