import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

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
    res.status(500).json({ error: 'Failed to load support contacts.' });
  }
});

router.get('/emergency-mode', requireAuth, requireOfficial, async (_req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.doc('systemSettings/emergencyMode').get();
    const data = snapshot.exists ? snapshot.data() : { active: false };
    res.json({ data });
  } catch (error) {
    console.error('Get emergency mode failed:', error);
    res.status(500).json({ error: 'Failed to load emergency mode status.' });
  }
});

router.patch('/emergency-mode', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can change emergency mode.' });
  }
  const { active } = req.body ?? {};
  try {
    await db.doc('systemSettings/emergencyMode').set({
      active: Boolean(active),
      changedBy: req.user!.uid,
      changedAt: new Date(),
    }, { merge: true });
    const updated = await db.doc('systemSettings/emergencyMode').get();
    res.json({ data: updated.data() });
  } catch (error) {
    console.error('Update emergency mode failed:', error);
    res.status(500).json({ error: 'Failed to update emergency mode.' });
  }
});

export default router;