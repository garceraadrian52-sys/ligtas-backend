import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { normalizeRole } from '../services/roles';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { findHouseholdByDisplayId, normalizeHouseholdDisplayId } from '../services/householdReference';
import { FieldValue } from 'firebase-admin/firestore';
import { HouseholdEditError, validateHouseholdEdit } from '../services/householdEditing';
import { ensureHouseholdReference, HouseholdReferenceError } from '../services/householdReferenceAssignment';
import { MembershipError, resolveJoinReference, previewHousehold, requestMembership, decideMembership, createResidentHousehold } from '../services/householdMembership';

const router = Router();

router.post('/preview', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = await resolveJoinReference(db, req.body?.reference, req.profile);
    res.json({ data: await previewHousehold(db, id, req.user!.uid) });
  } catch (error) { membershipFailure(error, res); }
});

router.post('/join', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = await resolveJoinReference(db, req.body?.reference, req.profile);
    res.status(201).json({ data: await requestMembership(db, id, req.user!.uid, req.body) });
  } catch (error) { membershipFailure(error, res); }
});

router.post('/requests/:requestId/decision', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(req.params.requestId)) || typeof req.body?.approve !== 'boolean') {
    return res.status(400).json({ error: 'Select Approve or Reject for a valid request.' });
  }
  try {
    const data = await decideMembership(db, String(req.params.requestId), req.user!.uid, req.body.approve, req.body.identityConfirmed === true);
    res.status('conflict' in data ? 409 : 200).json({ data, ...('message' in data ? { error: data.message } : {}) });
  } catch (error) { membershipFailure(error, res); }
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const id = await createResidentHousehold(db, req.user!.uid, req.body);
    const snapshot = await db.doc(`households/${id}`).get();
    res.status(201).json({ data: { ...snapshot.data(), id } });
  } catch (error) { membershipFailure(error, res); }
});

function membershipFailure(error: unknown, res: import('express').Response) {
  if (respondToFirestoreResourceExhausted(res, error)) return;
  if (error instanceof MembershipError) { res.status(error.status).json({ error: error.message }); return; }
  console.error('Household membership operation failed:', error);
  res.status(503).json({ error: 'Household membership is temporarily unavailable. Please try again.' });
}

// Resolve a public household reference for a resident's own barangay. Private
// household fields are never returned; the client continues using the legacy
// internal document ID for the existing membership-request rules.
router.post('/resolve', requireAuth, async (req: AuthenticatedRequest, res) => {
  const displayId = normalizeHouseholdDisplayId(req.body?.displayId);
  if (!displayId) return res.status(400).json({ error: 'Enter a valid household reference number.' });
  if (normalizeRole(req.user!.role) !== 'RESIDENT') return res.status(403).json({ error: 'Only residents can resolve a household reference.' });
  if (!req.user!.barangayId) return res.status(403).json({ error: 'Select your barangay before joining a household.' });

  try {
    const result = await findHouseholdByDisplayId(db, displayId, req.user!.barangayId!);
    if (result.kind === 'duplicate') return res.status(409).json({ error: 'This household reference is duplicated. Contact your barangay office.' });
    if (result.kind === 'missing') return res.status(404).json({ error: 'No household with that reference was found in your barangay.' });
    res.json({ data: { id: result.id, displayId } });
  } catch (error) {
    console.error('Resolve household reference failed:', error);
    res.status(500).json({ error: 'Unable to look up this household reference.' });
  }
});

router.patch('/:id/details', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (normalizeRole(req.user!.role) !== 'RESIDENT') return res.status(403).json({ error: 'Only resident household heads can edit a household.' });
  const id = String(req.params.id);
  if (!/^H-[A-Z0-9-]{5,36}$/i.test(id)) return res.status(400).json({ error: 'Invalid household ID.' });
  try {
    const ref = db.doc(`households/${id}`);
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) throw new HouseholdEditError('This household is no longer available.', 404);
      const evacuation = await transaction.get(db.doc(`activeEvacuations/${id}`));
      const current = snapshot.data()!;
      const details = validateHouseholdEdit(req.body, current, req.user!.uid, evacuation.data());
      const headIndex = current.members.findIndex((member: any) => member.id === 'head');
      transaction.update(ref, { ...details,
        ...(headIndex >= 0 ? { head: details.members.find(member => member.id === 'head')!.name } : {}),
        updatedAt: FieldValue.serverTimestamp() });
    });
    res.json({ data: { saved: true } });
  } catch (error) {
    if (error instanceof HouseholdEditError) return res.status(error.status).json({ error: error.message });
    console.error('Update household details failed:', error);
    res.status(500).json({ error: 'Unable to save household details.' });
  }
});

router.post('/:id/reference', requireAuth, async (req: AuthenticatedRequest, res) => {
  if (normalizeRole(req.user!.role) !== 'RESIDENT') return res.status(403).json({ error: 'Only household residents can request this reference.' });
  const id = String(req.params.id);
  if (!/^H-[A-Z0-9-]{5,36}$/i.test(id)) return res.status(400).json({ error: 'Invalid household ID.' });
  try {
    const displayId = await ensureHouseholdReference(db, id, req.user!.uid);
    res.json({ data: { displayId } });
  } catch (error) {
    if (error instanceof HouseholdReferenceError) return res.status(error.status).json({ error: error.message });
    console.error('Assign household reference failed:', error);
    res.status(503).json({ error: 'Household reference assignment is temporarily unavailable.' });
  }
});

export default router;
