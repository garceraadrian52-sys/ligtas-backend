import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { normalizeRole } from '../services/roles';
import { findHouseholdByDisplayId, normalizeHouseholdDisplayId, parseHouseholdJoinReference, submitHouseholdJoin } from '../services/householdReference';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';

const router = Router();

const joinErrors = {
  forbidden: [403, 'Only residents can request household membership.'],
  'no-barangay': [403, 'Select your barangay before joining a household.'],
  member: [409, 'You already belong to a household.'],
  pending: [409, 'You already have a request awaiting approval.'],
  duplicate: [409, 'This household reference is duplicated. Contact your barangay office.'],
  missing: [404, 'No household with that reference was found.'],
  'no-reviewer': [409, 'This household cannot receive requests. Contact your barangay office.'],
} as const;

router.post('/join', requireAuth, async (req: AuthenticatedRequest, res) => {
  const reference = parseHouseholdJoinReference(req.body?.reference);
  const relationship = typeof req.body?.relationship === 'string' ? req.body.relationship.trim() : '';
  if (!reference) return res.status(400).json({ error: 'Enter a valid household ID or reference number, or scan its QR code.' });
  if (!relationship || relationship.length > 120) return res.status(400).json({ error: 'Enter your relationship to the household head (up to 120 characters).' });

  try {
    const result = await submitHouseholdJoin(db, req.user!.uid, reference, relationship);
    if (result === 'submitted') return res.status(201).json({ data: { status: 'Pending' } });
    const [status, error] = joinErrors[result];
    return res.status(status).json({ error });
  } catch (error) {
    if (respondToFirestoreResourceExhausted(res, error)) return;
    console.error('Submit household request failed:', error);
    return res.status(503).json({ error: 'Household requests are temporarily unavailable. Please try again.' });
  }
});

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

export default router;
