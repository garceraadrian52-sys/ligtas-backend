import { FieldValue, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { normalizeRole } from './roles';
import { findHouseholdByDisplayId } from './householdReference';
import { allocateDisplayId } from './recordDisplayIds';
import { memberAccountId } from './householdEditing';

export class MembershipError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function requiredText(value: unknown, label: string, limit = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) {
    throw new MembershipError(`Enter ${label} (up to ${limit} characters).`);
  }
  return value.trim();
}

function resident(profile: any) {
  if (!profile || normalizeRole(profile.role) !== 'RESIDENT' || profile.disabled === true) {
    throw new MembershipError('An active resident account is required.', 403);
  }
}

function membersOf(household: any): any[] {
  if (!Array.isArray(household.members) || household.members.length > 100
    || household.members.some((member: any) => !member || typeof member.id !== 'string' || !member.id
      || typeof member.name !== 'string' || (member.userId != null && typeof member.userId !== 'string'))
    || new Set(household.members.map((member: any) => member.id)).size !== household.members.length) {
    throw new MembershipError('The household member list needs review by your barangay office.', 409);
  }
  const accounts = household.members.map((member: any) => memberAccountId(member, household)).filter(Boolean);
  if (new Set(accounts).size !== accounts.length) throw new MembershipError('This household has duplicate account links. Contact your barangay office.', 409);
  return household.members;
}

function assertArea(profile: any, household: any) {
  if (!profile.barangayId || profile.barangayId !== household.barangayId) {
    throw new MembershipError('No household with that reference was found in your barangay.', 404);
  }
}

export async function resolveJoinReference(db: Firestore, reference: unknown, profile: any): Promise<string> {
  resident(profile);
  if (!profile.barangayId) throw new MembershipError('Select your barangay before joining a household.');
  let value = requiredText(reference, 'a household code or QR', 500);
  if (value.startsWith('{')) {
    try {
      const qr = JSON.parse(value);
      if (qr.app !== 'ligtas' || qr.version !== 1 || typeof qr.householdId !== 'string') throw new Error();
      value = qr.householdId.trim();
    } catch { throw new MembershipError('This is not a LigTAS household QR.'); }
  }
  value = value.toUpperCase();
  if (/^H-[A-Z0-9-]{5,36}$/.test(value)) return value;
  if (!/^HH-\d{4,36}$/.test(value)) throw new MembershipError('Enter a valid household code or scan its QR.');
  const found = await findHouseholdByDisplayId(db, value, profile.barangayId);
  if (found.kind === 'duplicate') throw new MembershipError('This reference needs review by your barangay office.', 409);
  if (found.kind !== 'found') throw new MembershipError('No household with that reference was found in your barangay.', 404);
  return found.id;
}

export async function previewHousehold(db: Firestore, id: string, uid: string) {
  const [profileSnapshot, householdSnapshot] = await Promise.all([db.doc(`users/${uid}`).get(), db.doc(`households/${id}`).get()]);
  const profile = profileSnapshot.data();
  resident(profile);
  const household = householdSnapshot.data();
  if (!household) throw new MembershipError('No household with that reference was found in your barangay.', 404);
  assertArea(profile, household);
  // This projection deliberately omits contact details, address, account UIDs and all other household fields.
  return {
    id, name: String(household.name ?? household.householdName ?? 'Household'),
    head: String(household.head ?? household.householdHead ?? ''),
    ...(typeof household.displayId === 'string' ? { displayId: household.displayId } : {}),
    members: membersOf(household).map(member => ({ id: member.id, name: member.name,
      relationship: String(member.relationship ?? 'Not specified'), linked: Boolean(memberAccountId(member, household)) })),
  };
}

async function assertUnassigned(transaction: Transaction, db: Firestore, uid: string, profile: any) {
  if (profile.householdId || profile.householdMemberId) throw new MembershipError('This account already belongs to a household.', 409);
  // Also honor legacy memberships whose profile pointer was never populated.
  const memberships = await transaction.get(db.collection('households').where('memberUids', 'array-contains', uid));
  const owned = await transaction.get(db.collection('households').where('createdBy', '==', uid));
  if (!memberships.empty || !owned.empty) throw new MembershipError('This account is already linked to a household.', 409);
}

export async function requestMembership(db: Firestore, id: string, uid: string, input: any) {
  const memberId = input?.memberId != null ? requiredText(input.memberId, 'your selected member ID', 128) : null;
  if (input?.requestType === 'link_existing' && !memberId) throw new MembershipError('Select your household member record.');
  const relationship = memberId ? null : requiredText(input?.relationship, 'your relationship to the household head');
  const ref = db.collection('householdRequests').doc();
  await db.runTransaction(async transaction => {
    const profileRef = db.doc(`users/${uid}`);
    const profile = (await transaction.get(profileRef)).data();
    resident(profile);
    await assertUnassigned(transaction, db, uid, profile);
    if (profile!.pendingHouseholdId || profile!.pendingHouseholdRequestId) throw new MembershipError('You already have a request pending approval.', 409);
    const previous = await transaction.get(db.collection('householdRequests').where('userId', '==', uid));
    if (previous.docs.some(item => item.data().status === 'Pending')) throw new MembershipError('You already have a request pending approval.', 409);
    const household = (await transaction.get(db.doc(`households/${id}`))).data();
    if (!household) throw new MembershipError('Household not found.', 404);
    assertArea(profile, household);
    const members = membersOf(household);
    if (members.some(member => memberAccountId(member, household) === uid)) throw new MembershipError('Your account is already linked to a member.', 409);
    const selected = memberId ? members.find(member => member.id === memberId) : null;
    if (memberId && !selected) throw new MembershipError('This member is no longer listed. Look up the household again.', 409);
    if (selected && memberAccountId(selected, household)) throw new MembershipError('This member is Already Registered. Select your own unlinked record.', 409);
    if (!selected && members.length >= 100) throw new MembershipError('This household already has 100 members.', 409);
    transaction.create(ref, {
      householdId: id, userId: uid, name: requiredText(profile!.name ?? profile!.displayName, 'your registered name'),
      memberId, selectedMemberName: selected?.name ?? null,
      relationship: selected ? String(selected.relationship ?? 'Not specified') : relationship,
      status: 'Pending', requestVersion: ref.id, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.update(profileRef, { pendingHouseholdId: id, pendingHouseholdRequestId: ref.id, updatedAt: FieldValue.serverTimestamp() });
  });
  return { id: ref.id, status: 'Pending' };
}

export async function decideMembership(db: Firestore, requestId: string, headUid: string, approve: boolean, identityConfirmed = false) {
  return db.runTransaction(async transaction => {
    const requestRef = db.doc(`householdRequests/${requestId}`);
    const request = (await transaction.get(requestRef)).data();
    if (!request) throw new MembershipError('Request not found.', 404);
    const householdRef = db.doc(`households/${request.householdId}`);
    const household = (await transaction.get(householdRef)).data();
    const head = (await transaction.get(db.doc(`users/${headUid}`))).data();
    resident(head);
    if (!household || household.createdBy !== headUid) throw new MembershipError('Only the household head can decide this request.', 403);
    const intendedStatus = approve ? 'Approved' : 'Rejected';
    if (request.status === intendedStatus) return { status: intendedStatus };
    if (request.status !== 'Pending') throw new MembershipError('This request has already been decided.', 409);
    const applicantRef = db.doc(`users/${request.userId}`);
    const applicant = (await transaction.get(applicantRef)).data();
    const finish = (status: 'Approved' | 'Rejected', reason?: string, memberId?: string) => {
      transaction.update(requestRef, { status, decidedBy: headUid, decidedByName: String(head!.name ?? head!.displayName ?? 'Household head'),
        ...(status === 'Approved' && request.memberId ? { identityConfirmedBy: headUid, identityConfirmedAt: FieldValue.serverTimestamp() } : {}),
        decisionReason: reason ?? null, decidedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      const pendingMatches = applicant && (applicant.pendingHouseholdRequestId === requestId
        || (!applicant.pendingHouseholdRequestId && applicant.pendingHouseholdId === request.householdId));
      if (applicant && (pendingMatches || status === 'Approved')) {
        transaction.update(applicantRef, {
          ...(pendingMatches ? { pendingHouseholdId: null, pendingHouseholdRequestId: null } : {}),
          ...(status === 'Approved' ? { householdId: request.householdId, householdMemberId: memberId } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return { status, ...(reason ? { message: reason, conflict: true } : {}) };
    };
    if (!approve) return finish('Rejected');
    if (!applicant || normalizeRole(applicant.role) !== 'RESIDENT' || applicant.disabled === true) return finish('Rejected', 'The requesting resident account is unavailable.');
    if (applicant.pendingHouseholdRequestId && applicant.pendingHouseholdRequestId !== requestId) return finish('Rejected', 'The resident has a different pending request.');
    try { await assertUnassigned(transaction, db, request.userId, applicant); }
    catch (error) { if (error instanceof MembershipError) return finish('Rejected', error.message); throw error; }
    if (applicant.barangayId !== household.barangayId) return finish('Rejected', 'The resident now belongs to another barangay.');
    const members = membersOf(household);
    if (members.some(member => memberAccountId(member, household) === request.userId)) return finish('Rejected', 'This account is already linked to a member.');
    let nextMembers: any[];
    let memberId: string;
    if (request.memberId || request.requestType === 'link_existing') {
      const selected = members.find(member => member.id === request.memberId);
      if (!selected) return finish('Rejected', 'The selected member is no longer listed.');
      if (memberAccountId(selected, household)) return finish('Rejected', 'The selected member has already been linked to another account.');
      if (identityConfirmed !== true) throw new MembershipError('Confirm the requesting resident is the selected household member before approving.');
      memberId = selected.id;
      // Only account metadata changes. Attendance continues referencing exactly the same member ID.
      nextMembers = members.map(member => member.id === memberId ? { ...member, userId: request.userId } : member);
    } else if (request.requestType == null || request.requestType === 'add_new') {
      if (members.length >= 100) return finish('Rejected', 'This household already has 100 members.');
      if (members.some(member => member.id === request.userId)) return finish('Rejected', 'Select the existing member record instead of adding another.');
      const active = (await transaction.get(db.doc(`activeEvacuations/${request.householdId}`))).data();
      if (active && (!Array.isArray(active.memberIds) || active.memberIds.length)) throw new MembershipError('Check out active household members before adding a new member.', 409);
      memberId = request.userId;
      nextMembers = [...members, { id: memberId, userId: request.userId, name: requiredText(applicant.name ?? applicant.displayName, 'the registered resident name'),
        relationship: requiredText(request.relationship, 'the relationship to the head') }];
    } else { throw new MembershipError('This request type is not supported.', 409); }
    transaction.update(householdRef, { members: nextMembers,
      memberUids: [...new Set([...(household.memberUids ?? []), household.createdBy, request.userId].filter(Boolean))], updatedAt: FieldValue.serverTimestamp() });
    return finish('Approved', undefined, memberId);
  });
}

export async function createResidentHousehold(db: Firestore, uid: string, input: any) {
  const name = requiredText(input?.name, 'a household name');
  const street = requiredText(input?.street, 'a street address', 250);
  const contact = requiredText(input?.contact, 'a mobile number', 32).replace(/[\s()-]/g, '').replace(/^(?:\+63|63|0)/, '');
  if (!/^9\d{9}$/.test(contact)) throw new MembershipError('Enter a valid Philippine mobile number.');
  if (!Array.isArray(input?.members) || !input.members.length || input.members.length > 100) throw new MembershipError('Add between 1 and 100 household members.');
  const members = input.members.map((member: any) => ({ id: requiredText(member?.id, 'a member ID', 128),
    name: requiredText(member?.name, 'a member name'), relationship: requiredText(member?.relationship, 'a relationship') }));
  if (new Set(members.map((member: any) => member.id)).size !== members.length || members[0].id !== 'head') throw new MembershipError('Household members must have unique IDs and a head record.');
  const id = `H-${db.collection('households').doc().id.toUpperCase()}`;
  await db.runTransaction(async transaction => {
    const profileRef = db.doc(`users/${uid}`);
    const profile = (await transaction.get(profileRef)).data();
    resident(profile);
    await assertUnassigned(transaction, db, uid, profile);
    if (profile!.pendingHouseholdId || profile!.pendingHouseholdRequestId) throw new MembershipError('You have a request pending approval.', 409);
    const requests = await transaction.get(db.collection('householdRequests').where('userId', '==', uid));
    if (requests.docs.some(request => request.data().status === 'Pending')) throw new MembershipError('You have a request pending approval.', 409);
    if (!profile!.barangayId) throw new MembershipError('Select your barangay first.');
    const area = (await transaction.get(db.doc(`barangays/${profile!.barangayId}`))).data();
    if (!area) throw new MembershipError('Your assigned barangay is unavailable.');
    const headName = requiredText(profile!.name ?? profile!.displayName, 'your registered name');
    if (members.slice(1).some((member: any) => member.id === uid)) throw new MembershipError('The household head cannot be listed twice.');
    const displayId = await allocateDisplayId(transaction, db, 'households');
    transaction.create(db.doc(`households/${id}`), { name, street, contact, head: headName,
      barangayId: profile!.barangayId, barangay: String(area.name ?? area.displayName ?? profile!.barangayId),
      householdId: id, displayId, createdBy: uid, memberUids: [uid],
      members: [{ ...members[0], name: headName, userId: uid }, ...members.slice(1)],
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    transaction.update(profileRef, { householdId: id, householdMemberId: 'head', updatedAt: FieldValue.serverTimestamp() });
  });
  return id;
}
