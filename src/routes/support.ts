import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { isMunicipalityAdmin } from '../services/roles';

const router = Router();
router.get('/support', requireAuth, requireOfficial, async (_req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('emergencyContacts').get();
    const hotlines = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name ?? data.agency ?? 'Emergency Contact',
        number: data.number ?? data.phone ?? data.contactNumber ?? '',
      };
    });
    res.json({ data: { hotlines } });
  } catch (error) {
    console.error('Get support contacts failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load support contacts.' });
  }
});

router.get('/emergency-mode', requireAuth, requireOfficial, async (_req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.doc('systemSettings/emergencyMode').get();
    const data = snapshot.exists ? snapshot.data() ?? {} : {};
    const revision = Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0;
    res.json({ data: { ...data, active: data.active === true, revision } });
  } catch (error) {
    console.error('Get emergency mode failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load emergency mode status.' });
  }
});

router.patch('/emergency-mode', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (!isMunicipalityAdmin(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can change emergency mode.' });
  }
  const { active, expectedRevision } = req.body ?? {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'The emergency mode state must be a boolean.' });
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return res.status(400).json({ error: 'Refresh emergency mode before changing it.' });
  }

  const modeRef = db.doc('systemSettings/emergencyMode');
  try {
    const data = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(modeRef);
      const current = snapshot.exists ? snapshot.data() ?? {} : {};
      const revision = Number.isSafeInteger(current.revision) && current.revision >= 0 ? current.revision : 0;
      const currentState = { ...current, active: current.active === true, revision };

      if (revision !== expectedRevision) {
        const conflict = new Error('Emergency mode changed elsewhere. Refresh and try again.');
        Object.assign(conflict, { name: 'EmergencyModeRevisionConflict', current: currentState });
        throw conflict;
      }

      if (currentState.active === active) return currentState;

      const updated = {
        active,
        revision: revision + 1,
        changedBy: req.user!.uid,
        changedAt: new Date(),
      };
      transaction.set(modeRef, updated, { merge: true });
      return { ...currentState, ...updated };
    });
    res.json({ data });
  } catch (error) {
    if (error instanceof Error && error.name === 'EmergencyModeRevisionConflict') {
      return res.status(409).json({ error: error.message, data: (error as Error & { current: unknown }).current });
    }
    console.error('Update emergency mode failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update emergency mode.' });
  }
});

export default router;
