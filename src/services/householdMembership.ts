import { createHash, randomUUID } from 'node:crypto';
import { FieldValue, type DocumentData, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { isDeepStrictEqual } from 'node:util';
import { parseHouseholdJoinReference } from './householdReference';

export class HouseholdError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new HouseholdError(status, message); };
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const timestamp = () => FieldValue.serverTimestamp();
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\/\x00-\x1f]/.test(value);
type Member = DocumentData & { id: string; name: string; relationship: string; userId?: string };

function resident(profile: DocumentData | undefined): asserts profile is DocumentData {
  if (!profile || profile.disabled === true || text(profile.role).toUpperCase() !== 'RESIDENT') {
    fail(403, 'Only active residents can manage household membership.');
  }
}
function eligible(profile: DocumentData) {
  if (!text(profile.barangayId)) fail(403, 'Select your barangay before joining a household.');
  if (profile.householdId || profile.householdMemberId) fail(409, 'You already belong to a household.');
  if (profile.pendingHouseholdId || profile.pendingHouseholdRequestId) fail(409, 'You already have a request awaiting approval.');
}
// Honor legacy links and requests even if their profile pointers were omitted.
// Bounded queries avoid scanning household or request history.
async function unassigned(transaction: Transaction, db: Firestore, uid: string, profile: DocumentData) {
  if (profile.householdId || profile.householdMemberId) fail(409, 'You already belong to a household.');
  const memberships = await transaction.get(db.collection('households').where('memberUids', 'array-contains', uid).limit(1));
  const owned = await transaction.get(db.collection('households').where('createdBy', '==', uid).limit(1));
  if (!memberships.empty || !owned.empty) fail(409, 'This account is already linked to a household. Contact your barangay office to recover its profile.');
}
async function pendingRequests(transaction: Transaction, db: Firestore, uid: string, decidingId?: string) {
  const pending = await transaction.get(db.collection('householdRequests').where('userId', '==', uid)
    .where('status', '==', 'Pending').limit(decidingId ? 2 : 1));
  if (pending.docs.some(doc => doc.id !== decidingId)) fail(409, 'This account has another request awaiting approval.');
}
function memberList(household: DocumentData): Member[] {
  const members = household.members ?? [];
  if (!Array.isArray(members) || members.some(m => !m || !validId(m.id) || (m.userId != null && typeof m.userId !== 'string'))
    || new Set(members.map(m => m.id)).size !== members.length) {
    fail(409, 'This household has inconsistent member references. Contact your barangay office.');
  }
  if ((household.memberUids !== undefined && !Array.isArray(household.memberUids))
    || (household.retiredMembers !== undefined && !Array.isArray(household.retiredMembers))) {
    fail(409, 'This household has inconsistent membership information. Contact your barangay office.');
  }
  const accounts = members.map((m: Member) => m.userId || ((m.id === 'head' || m.id === household.createdBy)
    ? household.createdBy : household.memberUids?.includes(m.id) ? m.id : null)).filter(Boolean);
  if (new Set(accounts).size !== accounts.length) fail(409, 'This household has duplicate account links. Contact your barangay office.');
  return members;
}
function linked(member: Member, household: DocumentData) {
  return Boolean(member.userId || member.id === 'head' || member.id === household.createdBy
    || (Array.isArray(household.memberUids) && household.memberUids.includes(member.id)));
}
function memberIdentity(member: Member) {
  return { id: member.id, name: member.name ?? '', relationship: member.relationship ?? '', userId: member.userId ?? null };
}
function membershipRevision(request: DocumentData) {
  const revision = request.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) fail(409, 'This membership request needs administrator review.');
  return revision as number;
}
function details(household: DocumentData) {
  return { name: household.name ?? household.householdName ?? 'Household', street: household.street ?? household.address ?? '', contact: household.contact ?? household.contactNumber ?? '' };
}
function validatedDetails(input: any) {
  const name = text(input?.name), street = text(input?.street);
  const phone = /^(?:\+?63|0)?(9\d{9})$/.exec(text(input?.contact).replace(/[\s()-]/g, ''));
  if (!name || name.length > 120) fail(400, 'Enter a household name up to 120 characters.');
  if (!street || street.length > 250) fail(400, 'Enter a street address up to 250 characters.');
  if (!phone) fail(400, 'Enter a valid Philippine mobile contact number.');
  return { name, street, contact: phone![1] };
}
async function findHousehold(transaction: Transaction, db: Firestore, value: unknown) {
  const reference = parseHouseholdJoinReference(value);
  if (!reference) fail(400, 'Enter a valid household ID or reference number, or scan its QR code.');
  const households = db.collection('households');
  const candidates = reference!.displayIds
    ? (await transaction.get(households.where('displayId', 'in', reference!.displayIds).limit(2))).docs
    : [await transaction.get(households.doc(reference!.id!))];
  if (candidates.length > 1) fail(409, 'This household reference is duplicated. Contact your barangay office.');
  const snapshot = candidates[0];
  if (!snapshot?.exists) fail(404, 'No household with that reference was found.');
  const data = snapshot.data()!;
  if (!validId(data.createdBy)) fail(409, 'This household cannot receive requests. Contact your barangay office.');
  return { snapshot, data };
}
async function headHousehold(transaction: Transaction, db: Firestore, uid: string, id: string) {
  if (!/^H-[A-Z0-9-]{5,36}$/.test(id)) fail(400, 'Enter a valid household record ID.');
  const profile = (await transaction.get(db.doc(`users/${uid}`))).data();
  resident(profile);
  const snapshot = await transaction.get(db.doc(`households/${id}`));
  if (!snapshot.exists) fail(404, 'This household is no longer available.');
  const household = snapshot.data()!;
  if (household.createdBy !== uid) fail(403, 'Only the household head can perform this action.');
  return { snapshot, household, profile };
}

async function allocateHouseholdReference(transaction: Transaction, db: Firestore) {
  const counterRef = db.doc('recordIdCounters/households');
  const counter = await transaction.get(counterRef);
  const previous = counter.exists ? counter.get('lastIssued') : 0;
  if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) fail(409, 'The household reference counter needs administrator review.');
  const candidate = `HH-${String(previous + 1).padStart(5, '0')}`;
  const aliases = parseHouseholdJoinReference(candidate)!.displayIds!;
  const existing = await transaction.get(db.collection('households').where('displayId', 'in', aliases).limit(1));
  // Stop on an out-of-date counter; never migrate/reassign existing references.
  if (!existing.empty) fail(409, 'The next household reference already exists. Contact your administrator to review the counter.');
  transaction.set(counterRef, { prefix: 'HH-', lastIssued: previous + 1, updatedAt: new Date() }, { merge: true });
  return candidate;
}

/** Possession of a household QR/reference permits only this limited, authenticated preview. */
export async function previewHousehold(db: Firestore, uid: string, reference: unknown) {
  return db.runTransaction(async transaction => {
    const profile = (await transaction.get(db.doc(`users/${uid}`))).data();
    resident(profile);
    if (!text(profile.barangayId)) fail(403, 'Select your barangay before joining a household.');
    const { snapshot, data } = await findHousehold(transaction, db, reference);
    return { id: snapshot.id, ...(data.displayId ? { displayId: data.displayId } : {}),
      name: data.name ?? data.householdName ?? 'Household', head: data.head ?? data.householdHead ?? '',
      members: memberList(data).map(member => {
        const registered = linked(member, data);
        // Registered rows are display-only. Their legacy member ID may be an
        // account UID; keep it private without changing any stored identifiers.
        const id = registered ? 'registered:' + createHash('sha256').update(snapshot.id + '\0' + member.id).digest('hex') : member.id;
        return { id, name: member.name ?? '', relationship: member.relationship ?? '', linked: registered };
      }) };
  });
}

export async function requestHouseholdJoin(db: Firestore, uid: string, input: any) {
  const memberId = input?.memberId;
  if (input?.requestType === 'link_existing' && memberId === undefined) fail(400, 'Select your household member record.');
  if (input?.requestType != null && !['link_existing', 'add_new'].includes(input.requestType)) fail(400, 'Select a supported membership request type.');
  if (memberId !== undefined && !validId(memberId)) fail(400, 'Select a valid household member.');
  const relationship = text(input?.relationship);
  if (memberId === undefined && (!relationship || relationship.length > 120)) {
    fail(400, 'Enter your relationship to the household head (up to 120 characters).');
  }
  return db.runTransaction(async transaction => {
    const profileRef = db.doc(`users/${uid}`);
    const profile = (await transaction.get(profileRef)).data();
    resident(profile); eligible(profile);
    await unassigned(transaction, db, uid, profile);
    await pendingRequests(transaction, db, uid);
    const { snapshot, data } = await findHousehold(transaction, db, input?.reference);
    const members = memberList(data);
    if (data.createdBy === uid || data.memberUids?.includes(uid) || members.some(m => m.userId === uid || m.id === uid)) {
      fail(409, 'You already belong to this household. Contact your barangay office if your profile needs recovery.');
    }
    const selected = memberId === undefined ? undefined : members.find(m => m.id === memberId);
    if (memberId !== undefined && (!selected || linked(selected, data))) fail(409, 'This member is no longer available for account association. Refresh the member list.');
    const requestRef = db.doc(`householdRequests/${snapshot.id}_${uid}`);
    const existing = await transaction.get(requestRef);
    if (existing.exists && existing.get('status') !== 'Rejected') fail(409, 'You already have a request awaiting approval.');
    const revision = existing.exists ? membershipRevision(existing.data()!) + 1 : 1;
    if (!Number.isSafeInteger(revision)) fail(409, 'This membership request needs administrator review.');
    // Match the existing add-new request schema for older clients. No member/profile
    // association is written until the head approves in the decision transaction.
    transaction.set(requestRef, { householdId: snapshot.id, userId: uid, name: profile.name ?? profile.displayName ?? '',
      relationship: selected?.relationship ?? relationship, status: 'Pending', revision,
      ...(selected ? { requestType: 'link_existing', memberId: selected.id, selectedMemberName: selected.name ?? '',
        selectedMemberIdentity: memberIdentity(selected) } : {}), createdAt: timestamp(), updatedAt: timestamp() });
    transaction.update(profileRef, { pendingHouseholdId: snapshot.id, pendingHouseholdRequestId: requestRef.id, updatedAt: timestamp() });
    // Additive field preserves newer clients that use the returned request ID.
    return { id: requestRef.id, status: 'Pending' as const };
  });
}

export async function decideHouseholdMembership(db: Firestore, uid: string, requestId: string, input: any) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 256 || /[\/\x00-\x1f]/.test(requestId)
    || typeof input?.approve !== 'boolean') fail(400, 'Choose Approve or Reject for a valid request.');
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) {
    fail(400, 'Refresh the membership request before reviewing it.');
  }
  return db.runTransaction(async transaction => {
    const requestRef = db.doc(`householdRequests/${requestId}`);
    const request = (await transaction.get(requestRef)).data();
    if (!request || !validId(request.userId) || typeof request.householdId !== 'string') fail(404, 'This membership request is no longer available.');
    const { snapshot, household, profile: headProfile } = await headHousehold(transaction, db, uid, request!.householdId);
    const revision = membershipRevision(request!);
    if (input.expectedRevision !== undefined && input.expectedRevision !== revision) fail(409, 'This request changed. Review the current selected member before deciding.');
    if (input.expectedRevision === undefined && revision > 1) fail(409, 'This request was resubmitted. Update LigTAS and review the current request before deciding.');
    const profileRef = db.doc(`users/${request!.userId}`);
    const profile = (await transaction.get(profileRef)).data();
    const members = memberList(household);
    const status = input.approve ? 'Approved' : 'Rejected';
    if (request!.status === status) {
      // Older add-new approvals stored a null memberId, but used the account UID
      // as the member key. Accept retries only when both independent links agree.
      const approvedMemberId = request!.memberId ?? ((request!.requestType == null || request!.requestType === 'add_new') ? request!.userId : null);
      if (status === 'Approved' && (profile?.householdId !== snapshot.id || profile?.householdMemberId !== approvedMemberId
        || !members.some(m => m.id === approvedMemberId && m.userId === request!.userId))) {
        fail(409, 'This approval no longer matches the household. Contact your barangay office.');
      }
      return { status };
    }
    if (request!.status !== 'Pending') fail(409, 'This request has already been decided. Refresh the requests.');
    const decision = { status, decidedBy: uid, decidedByName: text(headProfile.name ?? headProfile.displayName) || 'Household head',
      decisionReason: null, decidedAt: timestamp(), updatedAt: timestamp() };
    const pendingMatches = profile && (profile.pendingHouseholdRequestId === requestId
      || (!profile.pendingHouseholdRequestId && profile.pendingHouseholdId === snapshot.id));
    if (!input.approve) {
      transaction.update(requestRef, decision);
      if (pendingMatches) transaction.update(profileRef, { pendingHouseholdId: null, pendingHouseholdRequestId: null, updatedAt: timestamp() });
      return { status };
    }
    resident(profile);
    if (profile.householdId || profile.householdMemberId || profile.pendingHouseholdId !== snapshot.id
      || (profile.pendingHouseholdRequestId && profile.pendingHouseholdRequestId !== requestId)) fail(409, 'The resident’s membership changed. Refresh the request.');
    await unassigned(transaction, db, request!.userId, profile);
    await pendingRequests(transaction, db, request!.userId, requestId);
    if (request!.userId === uid || household.memberUids?.includes(request!.userId) || members.some(m => m.userId === request!.userId || m.id === request!.userId)) {
      fail(409, 'This account is already registered in the household.');
    }
    let memberId: string;
    let next: Member[];
    if (request!.memberId || request!.requestType === 'link_existing') {
      if (input.identityConfirmed !== true) fail(400, 'Confirm that the requesting account belongs to the selected person before approving.');
      const selected = members.find(m => m.id === request!.memberId);
      if (!selected || linked(selected, household)) fail(409, 'The selected member is no longer available. Reject this request and ask the resident to refresh.');
      if (request!.selectedMemberIdentity && !isDeepStrictEqual(memberIdentity(selected!), request!.selectedMemberIdentity)) {
        fail(409, 'The selected member information changed. Reject this request and ask the resident to select their record again.');
      }
      if (!request!.selectedMemberIdentity && request!.selectedMemberName != null && request!.selectedMemberName !== selected!.name) {
        fail(409, 'The selected member information changed. Reject this request and ask the resident to select their record again.');
      }
      memberId = selected!.id;
      // Retain the exact member ID and every existing field. Evacuation records
      // reference this ID, so never replace it with the Firebase account UID.
      next = members.map(m => m.id === memberId ? { ...m, userId: request!.userId } : m);
    } else {
      if (request!.requestType != null && request!.requestType !== 'add_new') fail(409, 'This membership request type needs administrator review.');
      memberId = request!.userId;
      if (!text(request!.relationship)) fail(409, 'This request has no relationship information. Ask the resident to submit it again.');
      if ((household.retiredMembers ?? []).some((m: Member) => m.id === memberId)) fail(409, 'This member reference already has household history. Contact your barangay office.');
      next = [...members, { id: memberId, name: profile.name ?? profile.displayName ?? request!.name ?? '', relationship: request!.relationship, userId: request!.userId }];
    }
    transaction.update(snapshot.ref, { members: next,
      memberUids: [...new Set([...(household.memberUids ?? []), uid, request!.userId])], updatedAt: timestamp() });
    transaction.update(profileRef, { householdId: snapshot.id, householdMemberId: memberId,
      pendingHouseholdId: null, pendingHouseholdRequestId: null, updatedAt: timestamp() });
    transaction.update(requestRef, { ...decision, memberId, identityConfirmed: input.identityConfirmed === true,
      ...(request!.memberId ? { identityConfirmedBy: uid, identityConfirmedAt: timestamp() } : {}) });
    return { status };
  });
}

export async function saveHouseholdMembers(db: Firestore, uid: string, id: string, input: any) {
  const updates = validatedDetails(input);
  if (!Array.isArray(input?.members) || !Array.isArray(input?.expectedMembers) || !input?.expectedDetails) fail(400, 'Refresh the household before saving member changes.');
  if (input.expectedMembers.some((m: any) => !m || !validId(m.id))) fail(400, 'Refresh the household before saving member changes.');
  if (input.members.length > 200 || new Set(input.members.map((m: any) => m?.id)).size !== input.members.length) fail(400, 'Each household member needs a unique record ID (maximum 200 members).');
  return db.runTransaction(async transaction => {
    const { snapshot, household } = await headHousehold(transaction, db, uid, id);
    const members = memberList(household);
    if (!isDeepStrictEqual(members.map(memberIdentity), input.expectedMembers.map(memberIdentity))
      || !isDeepStrictEqual(details(household), input.expectedDetails)) fail(409, 'Household information changed. Refresh it before saving again.');
    const retired: Member[] = household.retiredMembers ?? [];
    const next: Member[] = input.members.map((proposal: any) => {
      if (!proposal || !validId(proposal.id) || !text(proposal.name) || text(proposal.name).length > 120) fail(400, 'Enter a valid name and record ID for each member.');
      const previous = members.find(m => m.id === proposal.id);
      if (previous && linked(previous, household)) {
        if (!isDeepStrictEqual(memberIdentity(previous), memberIdentity(proposal))) fail(403, 'Registered members cannot be edited, removed, or reassigned here.');
        return previous;
      }
      if (proposal.userId || (!previous && (proposal.id === 'head' || proposal.id === uid || household.memberUids?.includes(proposal.id)))) fail(403, 'Account association requires a membership request and identity approval.');
      if (!previous && retired.some(m => m.id === proposal.id)) fail(409, 'A previous member already used this record ID. Refresh and add the member again.');
      if (!text(proposal.relationship) || text(proposal.relationship).length > 120) fail(400, 'Enter each member’s relationship to the household head (up to 120 characters).');
      return { ...(previous ?? {}), id: proposal.id,
        name: previous && proposal.name === previous.name ? previous.name : text(proposal.name),
        relationship: previous && proposal.relationship === previous.relationship ? previous.relationship : text(proposal.relationship) } as Member;
    });
    const removed = members.filter(m => !next.some(n => n.id === m.id));
    if (removed.some(m => linked(m, household))) fail(403, 'Registered members cannot be edited, removed, or reassigned here.');
    // A pending identity review must refer to the same person the resident selected.
    const changed = members.filter(m => !next.some(n => isDeepStrictEqual(memberIdentity(n), memberIdentity(m))));
    if (changed.length) {
      const pending = await transaction.get(db.collection('householdRequests').where('householdId', '==', id)
        .where('status', '==', 'Pending').select('memberId'));
      if (pending.docs.some(r => changed.some(m => m.id === r.get('memberId')))) {
        fail(409, 'Review the pending membership request before changing its selected member.');
      }
    }
    if (removed.length) {
      const active = (await transaction.get(db.doc(`activeEvacuations/${id}`))).data();
      if (removed.some(m => active?.memberIds?.includes(m.id))) fail(409, 'Check this member out of the evacuation center before removing them.');
    }
    transaction.update(snapshot.ref, { ...updates, members: next,
      ...(removed.length ? { retiredMembers: [...retired, ...removed.map(m => ({ ...m, removedBy: uid, removedAt: new Date() }))] } : {}), updatedAt: timestamp() });
    return { saved: true };
  });
}

export async function createResidentHousehold(db: Firestore, uid: string, input: any) {
  const info = validatedDetails(input);
  if (!Array.isArray(input?.members) || input.members.length > 200 || new Set(input.members.map((m: any) => m?.id)).size !== input.members.length) fail(400, 'Provide a household head and unique member records.');
  const id = `H-${randomUUID().toUpperCase()}`;
  return db.runTransaction(async transaction => {
    const profileRef = db.doc(`users/${uid}`);
    const profile = (await transaction.get(profileRef)).data();
    resident(profile); eligible(profile);
    await unassigned(transaction, db, uid, profile);
    await pendingRequests(transaction, db, uid);
    const head = text(profile.name ?? profile.displayName);
    if (!head) fail(409, 'Complete your resident profile before creating a household.');
    const area = (await transaction.get(db.doc(`barangays/${profile.barangayId}`))).data();
    const members: Member[] = input.members.map((m: any) => {
      if (!m || !validId(m.id) || !text(m.name) || text(m.name).length > 120) fail(400, 'Enter a name and unique record ID for each member.');
      if (m.id === 'head') return { id: 'head', name: head, relationship: 'Head of Household', userId: uid };
      if (m.userId || m.id === uid || !text(m.relationship) || text(m.relationship).length > 120) fail(400, 'New members must be manually listed with a relationship.');
      return { id: m.id, name: text(m.name), relationship: text(m.relationship) };
    });
    if (!members.some(m => m.id === 'head')) fail(400, 'Include the household head.');
    const displayId = await allocateHouseholdReference(transaction, db);
    const household = { ...info, householdId: id, displayId, head,
      barangay: text(area?.name ?? area?.displayName) || text(input.barangay) || profile.barangayId,
      barangayId: profile.barangayId, members, createdBy: uid, memberUids: [uid] };
    transaction.create(db.doc(`households/${id}`), { ...household, createdAt: timestamp(), updatedAt: timestamp() });
    transaction.update(profileRef, { householdId: id, householdMemberId: 'head', updatedAt: timestamp() });
    return { id, ...household };
  });
}

export async function householdReference(db: Firestore, uid: string, id: string) {
  return db.runTransaction(async transaction => {
    if (!/^H-[A-Z0-9-]{5,36}$/.test(id)) fail(400, 'Enter a valid household record ID.');
    const profile = (await transaction.get(db.doc(`users/${uid}`))).data();
    resident(profile);
    const ref = db.doc(`households/${id}`);
    const household = (await transaction.get(ref)).data();
    if (!household) return fail(404, 'This household is no longer available.');
    if (household.createdBy !== uid && (profile.householdId !== id || !household.memberUids?.includes(uid))) fail(403, 'You cannot assign a reference to this household.');
    if (text(household.displayId)) {
      if (!parseHouseholdJoinReference(household.displayId)?.displayIds) fail(409, 'Contact your barangay office to check this household reference.');
      return { displayId: household.displayId };
    }
    const displayId = await allocateHouseholdReference(transaction, db);
    transaction.update(ref, { displayId });
    return { displayId };
  });
}
