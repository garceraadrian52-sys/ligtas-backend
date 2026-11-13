import { Router, type Response } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { isMunicipalityAdmin, normalizeRole } from '../services/roles';
import { findHouseholdByDisplayId, normalizeHouseholdDisplayId } from '../services/householdReference';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { HouseholdError, createResidentHousehold, decideHouseholdMembership, householdReference,
  previewHousehold, requestHouseholdJoin, saveHouseholdMembers } from '../services/householdMembership';

const router = Router();

async function operation(res: Response, run: () => Promise<unknown>, status = 200) {
  try {
    res.status(status).json({ data: await run() });
  } catch (error) {
    if (error instanceof HouseholdError) return res.status(error.status).json({ error: error.message });
    if (respondToFirestoreResourceExhausted(res, error)) return;
    console.error('Household operation failed:', (error as { code?: unknown })?.code ?? 'unknown');
    res.status(503).json({ error: 'Household services are temporarily unavailable. Please try again.' });
  }
}
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.post('/', requireAuth, (req: AuthenticatedRequest, res) => {
  return operation(res, () => createResidentHousehold(db, req.user!.uid, req.body), 201);
});
router.post('/preview', requireAuth, (req: AuthenticatedRequest, res) => {
  return operation(res, () => previewHousehold(db, req.user!.uid, req.body?.reference));
});
router.post('/join', requireAuth, (req: AuthenticatedRequest, res) => {
  return operation(res, () => requestHouseholdJoin(db, req.user!.uid, req.body), 201);
});
router.post('/requests/:requestId/decision', requireAuth, (req: AuthenticatedRequest, res) => {
  return operation(res, () => decideHouseholdMembership(db, req.user!.uid, String(req.params.requestId), req.body));
});
router.patch('/:id/details', requireAuth, (req: AuthenticatedRequest, res) => {
  return operation(res, () => saveHouseholdMembers(db, req.user!.uid, String(req.params.id), req.body));
});
router.post('/:id/reference', requireAuth, (req: AuthenticatedRequest, res) => {
  return operation(res, () => householdReference(db, req.user!.uid, String(req.params.id)));
});

// Resolve only an authorized read's internal key. Resident/official reads stay
// in their assigned barangay; municipal staff retain their existing wider scope.
router.post('/resolve', requireAuth, async (req: AuthenticatedRequest, res) => {
  const displayId = normalizeHouseholdDisplayId(req.body?.displayId);
  if (!displayId) return res.status(400).json({ error: 'Enter a valid household reference number.' });
  const role = normalizeRole(req.user!.role);
  const municipal = isMunicipalityAdmin(role);
  if (!municipal && !['RESIDENT', 'BARANGAY_OFFICIAL'].includes(role)) return res.status(403).json({ error: 'This account cannot look up household references.' });
  if (!municipal && !req.user!.barangayId) return res.status(403).json({ error: 'Select your barangay before looking up a household.' });

  try {
    const result = await findHouseholdByDisplayId(db, displayId, municipal ? null : req.user!.barangayId!);
    if (result.kind === 'duplicate') return res.status(409).json({ error: 'This household reference is duplicated. Contact your barangay office.' });
    if (result.kind === 'missing') return res.status(404).json({ error: 'No household with that reference was found in your barangay.' });
    res.json({ data: { id: result.id, displayId } });
  } catch (error) {
    console.error('Resolve household reference failed:', error);
    res.status(500).json({ error: 'Unable to look up this household reference.' });
  }
});

export default router;
