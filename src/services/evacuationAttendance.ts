import { createHash } from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import boundaries from '../config/barangayBoundaries.json';
import { parseHouseholdJoinReference } from './householdReference';
import { validDocumentId, validText } from './inputValidation';
import { isMunicipalityAdmin, normalizeRole } from './roles';
import { auditRecord } from './auditLog';

export class AttendanceError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'invalid_attendance') { super(message); }
}
const fail = (status: number, message: string, code?: string): never => { throw new AttendanceError(status, message, code); };
const canonical = (value: unknown) => String(value ?? '').toLowerCase().replace(/^barangay[\s_-]*/, '').replace(/[\s_-]/g, '');
const localBarangays = new Set(boundaries.features.map(item => canonical(item.properties.id)));
function municipality(data: Record<string, any>) {
  for (const key of ['municipalityId', 'lguId', 'municipality']) {
    if (data[key] != null && !['balagtas', 'balagtasbulacan'].includes(String(data[key]).toLowerCase().replace(/[^a-z]/g, ''))) {
      fail(403, 'This record is outside the configured municipality.');
    }
  }
}
async function barangay(tx: Transaction, db: Firestore, id: unknown) {
  if (!validDocumentId(id) || !localBarangays.has(canonical(id))) fail(403, 'The barangay is outside the configured municipality.');
  const area = (await tx.get(db.doc('barangays/' + id))).data();
  if (!area) fail(403, 'The barangay assignment could not be verified.');
  municipality(area!);
}
async function operator(tx: Transaction, db: Firestore, uid: string, centerId: string) {
  if (!validDocumentId(centerId)) fail(400, 'Choose a valid evacuation center.');
  const profile = (await tx.get(db.doc('users/' + uid))).data();
  if (!profile || profile.disabled === true) fail(403, 'This account cannot record attendance.');
  const role = normalizeRole(profile!.role);
  if (!isMunicipalityAdmin(role) && role !== 'BARANGAY_OFFICIAL') fail(403, 'Only authorized officials can record attendance.');
  municipality(profile!);
  const centerRef = db.doc('evacuationCenters/' + centerId), center = (await tx.get(centerRef)).data();
  if (!center) fail(404, 'Evacuation center no longer exists.');
  municipality(center!);
  await barangay(tx, db, center!.barangayId);
  if (role === 'BARANGAY_OFFICIAL') {
    await barangay(tx, db, profile!.barangayId);
    if (canonical(profile!.barangayId) !== canonical(center!.barangayId)) fail(403, 'You are not authorized to operate this evacuation center.');
  }
  return { profile: profile!, role, center: center!, centerRef };
}
async function household(tx: Transaction, db: Firestore, reference: unknown) {
  const parsed = parseHouseholdJoinReference(reference);
  if (!parsed) fail(400, 'Scan a LigTAS household QR or enter a valid household ID.');
  const candidates = parsed!.id ? [await tx.get(db.doc('households/' + parsed!.id))]
    : (await tx.get(db.collection('households').where('displayId', 'in', parsed!.displayIds!).limit(2))).docs;
  if (candidates.length > 1) fail(409, 'This household reference is duplicated. Contact your barangay office.');
  const snapshot = candidates[0], data = snapshot?.data();
  if (!snapshot?.exists || !data) fail(404, 'Household not found.');
  municipality(data!);
  await barangay(tx, db, data!.barangayId);
  if (!Array.isArray(data!.members) || !data!.members.length || data!.members.length > 100
    || data!.members.some((member: any) => !validText(member.id, 150))
    || new Set(data!.members.map((member: any) => member.id)).size !== data!.members.length) {
    fail(409, 'Household members need administrator review.');
  }
  return { id: snapshot!.id, data: data! };
}
export function attendanceHousehold(db: Firestore, uid: string, centerId: string, reference: unknown) {
  return db.runTransaction(async tx => {
    await operator(tx, db, uid, centerId);
    const result = await household(tx, db, reference);
    const active = (await tx.get(db.doc('activeEvacuations/' + result.id))).data();
    // Return only the identity/member fields needed for check-in, never private contact/address data.
    return { id: result.id, displayId: result.data.displayId ?? null, name: result.data.name ?? result.data.householdName ?? 'Household',
      head: String(result.data.head ?? result.data.members.find((member: any) => member.relationship === 'Head')?.name ?? ''),
      barangayId: result.data.barangayId,
      members: result.data.members.map((member: any) => ({ id: member.id, name: String(member.name ?? member.id), relationship: String(member.relationship ?? 'Household member') })),
      activeMemberIds: Array.isArray(active?.memberIds) ? active.memberIds : [], activeCenterId: active?.evacuationCenterId ?? null };
  });
}
function totals(center: any) {
  const occupied = center.occupied ?? center.currentOccupancy ?? center.occupancyCount ?? 0;
  const capacity = center.capacity ?? center.maxCapacity ?? 0;
  if (!Number.isSafeInteger(occupied) || occupied < 0 || !Number.isSafeInteger(capacity) || capacity < 0
    || ['occupied', 'currentOccupancy', 'occupancyCount'].some(key => center[key] != null && center[key] !== occupied)) {
    fail(409, 'Center occupancy needs correction by an administrator.');
  }
  return { occupied, capacity };
}
export type AttendanceResult = {
  status: 'checked_in' | 'already_checked_in' | 'already_processed';
  addedCount: number; duplicateCount: number; centerId: string;
};
export function recordAttendance(db: Firestore, uid: string, centerId: string, body: any): Promise<AttendanceResult> {
  if (!validDocumentId(body?.id) || body.id.length > 150 || !validDocumentId(body?.householdId)
    || !Array.isArray(body.memberIds) || body.memberIds.length < 1 || body.memberIds.length > 100
    || body.memberIds.some((id: unknown) => !validText(id, 150))) fail(400, 'Choose a center and valid household members.');
  const selected: string[] = [...new Set<string>(body.memberIds)];
  const fingerprint = createHash('sha256').update(JSON.stringify({ centerId, householdId: body.householdId, manual: body.manual === true, duplicateReviewOnly: body.duplicateReviewOnly === true, selected: [...selected].sort() })).digest('hex');
  return db.runTransaction(async tx => {
    const { center, centerRef, profile, role } = await operator(tx, db, uid, centerId);
    const receiptRef = db.doc('evacuationSubmissions/' + body.id), receipt = (await tx.get(receiptRef)).data();
    if (receipt) {
      if (receipt.ownerId !== uid || receipt.fingerprint !== fingerprint) fail(409, 'This saved attendance belongs to a different request.');
      return { ...receipt.result, status: receipt.result.status === 'checked_in' ? 'already_processed' : receipt.result.status, addedCount: 0 };
    }
    const recordRef = db.doc('evacuationRecords/' + body.id), previous = (await tx.get(recordRef)).data();
    if (previous) {
      if (previous.recordedBy !== uid || previous.householdId !== body.householdId || previous.evacuationCenterId !== centerId
        || !Array.isArray(previous.memberIds) || previous.memberIds.some((id: string) => !selected.includes(id))) {
        fail(409, 'This saved attendance belongs to a different request.');
      }
      return { status: 'already_processed', addedCount: 0, duplicateCount: selected.length, centerId };
    }
    const manual = body.manual === true;
    if (manual && (!/^MANUAL-[A-Z0-9-]+$/i.test(body.householdId) || !validText(body.householdName, 200)
      || !Array.isArray(body.memberNames) || body.memberNames.length !== body.memberIds.length
      || body.memberNames.some((name: unknown) => !validText(name, 200)))) fail(400, 'Enter the household name and present members.');
    const found = manual ? null : await household(tx, db, body.householdId);
    const validMembers = found?.data.members.map((member: any) => member.id);
    if (validMembers && selected.some(id => !validMembers.includes(id))) fail(409, 'Household members changed. Look up the household again.');
    const activeRef = db.doc('activeEvacuations/' + body.householdId), active = (await tx.get(activeRef)).data();
    if (active) { municipality(active); await barangay(tx, db, active.barangayId); }
    const existing: string[] = active?.memberIds ?? [];
    if (!Array.isArray(existing) || existing.some(id => typeof id !== 'string') || new Set(existing).size !== existing.length) fail(409, 'Active attendance needs administrator review.');
    if (existing.length && !validDocumentId(active?.evacuationCenterId)) fail(409, 'Active attendance needs administrator review.');
    const eligible = selected.filter(id => !existing.includes(id));
    const reviewOnly = body.duplicateReviewOnly === true;
    const added = reviewOnly ? [] : eligible, now = new Date();
    const result: AttendanceResult = { status: reviewOnly && eligible.length ? 'already_processed' : added.length ? 'checked_in' : 'already_checked_in', addedCount: added.length,
      duplicateCount: selected.length - eligible.length, centerId: !added.length ? active?.evacuationCenterId ?? centerId : centerId };
    if (added.length) {
      if (existing.length && active?.evacuationCenterId !== centerId) fail(409, 'This household is checked in at another center. Check out before transferring.');
      const { occupied, capacity } = totals(center);
      if (center.active === false || center.isActive === false || ['FULL', 'CLOSED', 'UNAVAILABLE', 'INACTIVE', 'DEACTIVATED'].includes(String(center.status ?? 'OPEN').toUpperCase())) fail(409, 'This evacuation center is unavailable. Select an active center.');
      if (existing.length + added.length > 100 || (capacity > 0 && occupied + added.length > capacity)) fail(409, 'This center has insufficient capacity. Select another center.');
      const barangayId = found?.data.barangayId ?? profile.barangayId ?? center.barangayId;
      const names = added.map(id => found ? String(found.data.members.find((member: any) => member.id === id).name ?? id)
        : body.memberNames[body.memberIds.indexOf(id)]);
      tx.create(recordRef, { householdId: body.householdId, householdName: String(found?.data.name ?? found?.data.householdName ?? body.householdName ?? 'Household'),
        evacuationCenterId: centerId, evacuationCenter: String(center.name ?? centerId), memberIds: added, memberNames: names,
        absentMemberIds: validMembers ? validMembers.filter((id: string) => !existing.includes(id) && !selected.includes(id)) : [],
        peopleCount: added.length, barangayId, centerBarangayId: center.barangayId, manual,
        ...(manual ? { contact: typeof body.contact === 'string' ? body.contact.slice(0, 50) : '' } : {}),
        status: 'checked_in', recordedBy: uid, recordedByName: String(profile.name ?? profile.displayName ?? 'Official'),
        recordedAt: now, observedAt: typeof body.observedAt === 'string' && Number.isFinite(Date.parse(body.observedAt)) ? body.observedAt : now.toISOString(),
        createdAt: now, updatedAt: now, attendanceVersion: 2 });
      tx.set(activeRef, { householdId: body.householdId, evacuationCenterId: centerId, memberIds: [...existing, ...added],
        barangayId, centerBarangayId: center.barangayId, lastAttendanceId: body.id, updatedAt: now });
      tx.update(centerRef, { occupied: occupied + added.length, currentOccupancy: occupied + added.length,
        occupancyCount: occupied + added.length, lastAttendanceId: body.id, updatedAt: now });
      tx.create(db.doc('auditLogs/attendance-' + body.id), auditRecord({ actorId: uid, actorName: String(profile.name ?? 'Official'), actorRole: role,
        actorBarangayId: profile.barangayId ?? null, action: 'evacuation_checkin', targetType: 'evacuationRecord', targetId: body.id,
        details: { centerId, peopleCount: added.length } }));
    }
    // A server-only receipt also makes all-duplicate submissions safe after a later checkout.
    tx.create(receiptRef, { ownerId: uid, fingerprint, result, createdAt: now });
    return result;
  });
}
export function checkoutCenterAttendance(db: Firestore, uid: string, centerId: string, recordId: string) {
  if (!validDocumentId(recordId)) fail(400, 'Choose a valid attendance record.');
  return db.runTransaction(async tx => {
    const { center, centerRef, profile, role } = await operator(tx, db, uid, centerId);
    const recordRef = db.doc('evacuationRecords/' + recordId), record = (await tx.get(recordRef)).data();
    if (!record || record.evacuationCenterId !== centerId) fail(404, 'Attendance record not found at this center.');
    if (record!.status === 'checked_out') return { status: 'already_processed' };
    if (record!.status !== 'checked_in') fail(409, 'This attendance record is not checked in. No changes were made.');
    municipality(record!);
    await barangay(tx, db, record!.barangayId);
    if (!record!.manual) await household(tx, db, record!.householdId);
    const activeRef = db.doc('activeEvacuations/' + record!.householdId), active = (await tx.get(activeRef)).data();
    const { occupied } = totals(center);
    const members: string[] = record!.memberIds ?? [], existing: string[] = active?.memberIds ?? [];
    if (!active || active.evacuationCenterId !== centerId || !Array.isArray(members) || !Array.isArray(existing)
      || !members.length || members.length !== record!.peopleCount || new Set(members).size !== members.length
      || new Set(existing).size !== existing.length || !members.every(id => existing.includes(id)) || occupied < members.length) fail(409, 'Attendance totals need reconciliation by an administrator. No changes were made.');
    const now = new Date(), next = occupied - members.length;
    tx.update(recordRef, { status: 'checked_out', checkedOutAt: now, checkedOutBy: uid, updatedAt: now });
    tx.update(activeRef, { memberIds: existing.filter(id => !members.includes(id)), lastAttendanceId: recordId, updatedAt: now });
    tx.update(centerRef, { occupied: next, currentOccupancy: next, occupancyCount: next, lastAttendanceId: recordId, updatedAt: now });
    tx.create(db.collection('auditLogs').doc(), auditRecord({ actorId: uid, actorName: String(profile.name ?? 'Official'), actorRole: role,
      actorBarangayId: profile.barangayId ?? null, action: 'evacuation_checkout', targetType: 'evacuationRecord', targetId: recordId, details: { centerId, peopleCount: members.length } }));
    return { status: 'checked_out' };
  });
}
export async function listCenterAttendance(db: Firestore, uid: string) {
  const profile = (await db.doc('users/' + uid).get()).data();
  if (!profile || profile.disabled || (!isMunicipalityAdmin(profile.role) && normalizeRole(profile.role) !== 'BARANGAY_OFFICIAL')) fail(403, 'Only authorized officials can view attendance.');
  municipality(profile!);
  if (!isMunicipalityAdmin(profile!.role) && !localBarangays.has(canonical(profile!.barangayId))) fail(403, 'The barangay assignment could not be verified.');
  const records = db.collection('evacuationRecords');
  const snapshots = isMunicipalityAdmin(profile!.role) ? [await records.get()] : await Promise.all([
    records.where('centerBarangayId', '==', profile!.barangayId).get(),
    records.where('barangayId', '==', profile!.barangayId).get(),
  ]);
  const centers = await db.collection('evacuationCenters').get();
  const permitted = new Map(centers.docs.filter(item => {
    const data = item.data();
    try { municipality(data); return localBarangays.has(canonical(data.barangayId)); } catch { return false; }
  }).map(item => [item.id, item.data()]));
  const unique = new Map(snapshots.flatMap(snapshot => snapshot.docs).map(item => [item.id, item]));
  return [...unique.values()].flatMap(item => {
    const data = item.data();
    if (!permitted.has(data.evacuationCenterId) || !localBarangays.has(canonical(data.barangayId))) return [];
    if (!isMunicipalityAdmin(profile!.role) && canonical(data.barangayId) !== canonical(profile!.barangayId)
      && canonical(permitted.get(data.evacuationCenterId)!.barangayId) !== canonical(profile!.barangayId)) return [];
    try { municipality(data); } catch { return []; }
    const millis = (value: any): number | null => {
      const result = value?.toMillis?.() ?? (value instanceof Date ? value.getTime()
        : typeof value === 'string' ? Date.parse(value) : value);
      return typeof result === 'number' && Number.isFinite(result) ? result : null;
    };
    return [{ id: item.id, householdId: data.householdId, householdName: data.householdName ?? 'Household',
      householdDisplayId: data.householdDisplayId ?? data.householdReference ?? null,
      evacuationCenterId: data.evacuationCenterId, evacuationCenter: data.evacuationCenter ?? data.centerName ?? '',
      memberIds: data.memberIds ?? [], memberNames: data.memberNames ?? [], peopleCount: data.peopleCount ?? 0,
      status: data.status ?? 'checked_in', recordedBy: data.recordedBy ?? null,
      recordedAt: millis(data.observedAt) ?? millis(data.recordedAt) ?? millis(data.createdAt) }];
  });
}
