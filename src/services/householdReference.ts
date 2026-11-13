import type { Firestore } from 'firebase-admin/firestore';

export type HouseholdReferenceLookup = { kind: 'found'; id: string } | { kind: 'missing' } | { kind: 'duplicate' };

export function normalizeHouseholdDisplayId(value: unknown) {
  if (typeof value !== 'string') return null;
  const reference = parseHouseholdJoinReference(value);
  return reference?.displayIds?.[0] ?? null;
}

export async function findHouseholdByDisplayId(db: Firestore, displayId: string, barangayId: string | null): Promise<HouseholdReferenceLookup> {
  const aliases = parseHouseholdJoinReference(displayId)?.displayIds;
  if (!aliases) return { kind: 'missing' };
  const snapshot = await db.collection('households').where('displayId', 'in', aliases).get();
  const localMatches = barangayId === null ? snapshot.docs : snapshot.docs.filter(doc => doc.data().barangayId === barangayId);
  if (localMatches.length > 1) return { kind: 'duplicate' };
  if (localMatches.length === 0) return { kind: 'missing' };
  return { kind: 'found', id: localMatches[0].id };
}

const internalIdPattern = /^H-[A-Z0-9-]{5,36}$/;

export function parseHouseholdJoinReference(value: unknown) {
  if (typeof value !== 'string') return null;
  if (value.trim().startsWith('{')) {
    try {
      const qr = JSON.parse(value);
      if (qr?.app !== 'ligtas' || qr.version !== 1 || typeof qr.householdId !== 'string') return null;
      value = qr.householdId;
    } catch { return null; }
  }
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
