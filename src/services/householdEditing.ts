type Member = { id: string; name: string; relationship: string; userId?: string };
type Details = { name: string; street: string; contact: string; members: Member[] };

export function memberAccountId(member: Member, household: { createdBy?: string }): string | null {
  if (typeof member.userId === 'string' && member.userId) return member.userId;
  if (household.createdBy && (member.id === 'head' || member.id === household.createdBy)) return household.createdBy;
  return null;
}

export class HouseholdEditError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function text(value: unknown, max: number, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new HouseholdEditError(`Enter ${label} (up to ${max} characters).`);
  }
  return value.trim();
}

export function validateHouseholdEdit(input: any, current: any, uid: string, activeEvacuation: any): Details {
  if (current.createdBy !== uid) throw new HouseholdEditError('Only the household head can edit this household.', 403);
  const name = text(input?.name, 120, 'a household name');
  const street = text(input?.street, 250, 'a street address');
  const contactInput = text(input?.contact, 25, 'a Philippine mobile number').replace(/[\s()-]/g, '');
  const contact = contactInput.replace(/^(?:\+63|63|0)/, '');
  if (!/^9\d{9}$/.test(contact)) throw new HouseholdEditError('Enter a valid Philippine mobile number.');
  if (!Array.isArray(input?.members) || !input.members.length || input.members.length > 100) {
    throw new HouseholdEditError('A household must have between 1 and 100 members.');
  }
  const before: Member[] = current.members;
  if (!Array.isArray(before)) throw new HouseholdEditError('This household needs assistance from your barangay office.', 409);
  // Compare the entire original list to prevent overwriting a newly approved member or another edit.
  const memberValues = (members: any[]) => members.map(member => [member?.id, member?.name, member?.relationship, member?.userId ?? null]);
  if (!Array.isArray(input.expectedMembers)
    || JSON.stringify(memberValues(input.expectedMembers)) !== JSON.stringify(memberValues(before))
    || input.expectedDetails?.name !== String(current.name ?? current.householdName ?? 'Household')
    || input.expectedDetails?.street !== String(current.street ?? current.address ?? '')
    || input.expectedDetails?.contact !== String(current.contact ?? current.contactNumber ?? '')) {
    throw new HouseholdEditError('Household changed. Close this form and reopen it to load the latest details.', 409);
  }
  const members: Member[] = input.members.map((member: any) => {
    if (!member || Object.keys(member).some(key => !['id', 'name', 'relationship', 'userId'].includes(key))) {
      throw new HouseholdEditError('Invalid household member details.');
    }
    const id = text(member.id, 128, 'a member ID');
    const previous = before.find(item => item.id === id);
    if (!previous && (id === 'head' || id === current.createdBy)) throw new HouseholdEditError('Household head member IDs are reserved.');
    // Account membership is granted only by the existing approval workflow.
    if ((previous?.userId ?? null) !== (member.userId ?? null)) {
      throw new HouseholdEditError('Linked resident accounts cannot be changed here.');
    }
    if (previous && memberAccountId(previous, current)
      && (member.name !== previous.name || member.relationship !== previous.relationship)) {
      throw new HouseholdEditError('Linked member identity information cannot be edited by the household head.');
    }
    if (previous && memberAccountId(previous, current)) return { ...previous };
    return { id, name: text(member.name, 120, 'a member name'), relationship: text(member.relationship, 120, 'a relationship'),
      ...(previous?.userId ? { userId: previous.userId } : {}) };
  });
  if (new Set(members.map(member => member.id)).size !== members.length
    || before.some(member => memberAccountId(member, current) && !members.some(next => next.id === member.id))) {
    throw new HouseholdEditError('Linked member IDs must be preserved and cannot be duplicated.');
  }
  if (JSON.stringify(memberValues(before)) !== JSON.stringify(memberValues(members)) && activeEvacuation
    && (!Array.isArray(activeEvacuation.memberIds) || activeEvacuation.memberIds.length)) {
    throw new HouseholdEditError('Members cannot be changed during an active evacuation check-in. Check out first.', 409);
  }
  return { name, street, contact, members };
}
