import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export type HouseholdReferenceLookup = { kind: 'found'; id: string } | { kind: 'missing' } | { kind: 'duplicate' };

export function normalizeHouseholdDisplayId(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^HH-\d{5,}$/.test(normalized) ? normalized : null;
}

export async function findHouseholdByDisplayId(db: Firestore, displayId: string, barangayId: string): Promise<HouseholdReferenceLookup> {
  const snapshot = await db.collection('households').where('displayId', '==', displayId).get();
  const localMatches = snapshot.docs.filter(doc => doc.data().barangayId === barangayId);
  if (localMatches.length > 1) return { kind: 'duplicate' };
  if (localMatches.length === 0) return { kind: 'missing' };
  return { kind: 'found', id: localMatches[0].id };
}

const internalIdPattern = /^H-[A-Z0-9-]{5,36}$/;

export function parseHouseholdJoinReference(value: unknown) {
  if (typeof value !== 'string') return null;
  const reference = value.trim().toUpperCase();
  if (internalIdPattern.test(reference)) return { id: reference };
  if (!/^HH-\d{4,36}$/.test(reference)) return null;
  const canonical = `HH-${reference.slice(3).padStart(5, '0')}`;
  const displayIds = canonical.length === 8 && canonical.startsWith('HH-0')
    ? [canonical, `HH-${canonical.slice(4)}`]
    : [canonical];
  return { displayIds };
}

export async function submitHouseholdJoin(
  db: Firestore,
  uid: string,
  reference: NonNullable<ReturnType<typeof parseHouseholdJoinReference>>,
  relationship: string,
) {
  return db.runTransaction(async (transaction) => {
    const profileRef = db.collection('users').doc(uid);
    const profile = (await transaction.get(profileRef)).data();
    if (!profile || profile.disabled === true || !['RESIDENT', 'resident'].includes(profile.role)) return 'forbidden';
    if (typeof profile.barangayId !== 'string' || !profile.barangayId.trim()) return 'no-barangay';
    if (profile.householdId) return 'member';
    if (profile.pendingHouseholdId) return 'pending';

    const households = db.collection('households');
    const candidates = reference.displayIds
      ? (await transaction.get(households.where('displayId', 'in', reference.displayIds).select('createdBy').limit(2))).docs
      : [await transaction.get(households.doc(reference.id))];
    if (candidates.length > 1) return 'duplicate';
    const household = candidates[0];
    if (!household?.exists || !internalIdPattern.test(household.id)) return 'missing';
    if (typeof household.get('createdBy') !== 'string' || !household.get('createdBy')) return 'no-reviewer';

    const requestRef = db.collection('householdRequests').doc(`${household.id}_${uid}`);
    const request = await transaction.get(requestRef);
    if (request.exists && request.get('status') !== 'Rejected') return 'pending';

    transaction.set(requestRef, {
      householdId: household.id, userId: uid, name: profile.name ?? profile.displayName ?? '',
      relationship, status: 'Pending', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(profileRef, { pendingHouseholdId: household.id, updatedAt: FieldValue.serverTimestamp() });
    return 'submitted';
  });
}
