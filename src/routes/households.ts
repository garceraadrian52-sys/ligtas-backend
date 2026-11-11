import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { normalizeRole } from '../services/roles';
import { findHouseholdByDisplayId, normalizeHouseholdDisplayId } from '../services/householdReference';

const router = Router();

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
