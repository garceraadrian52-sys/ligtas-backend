import type { Firestore } from 'firebase-admin/firestore';

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
