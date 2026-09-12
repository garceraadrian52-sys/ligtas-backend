import { Router } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /profile
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.doc(`users/${req.user!.uid}`).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Profile not found.' });
    res.json({ data: { id: snapshot.id, ...snapshot.data() } });
  } catch (error) {
    console.error('Get profile failed:', error);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// PATCH /profile
router.patch('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, phone, address } = req.body ?? {};
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (name) { updates.name = name; updates.displayName = name; }
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;

    await db.doc(`users/${req.user!.uid}`).update(updates);
    const updated = await db.doc(`users/${req.user!.uid}`).get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update profile failed:', error);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// PATCH /profile/password
router.patch('/password', async (req: AuthenticatedRequest, res) => {
  const { newPassword } = req.body ?? {};
  if (!newPassword || newPassword.length < 12) {
    return res.status(400).json({ error: 'newPassword must be at least 12 characters.' });
  }

  try {
    await auth.updateUser(req.user!.uid, { password: newPassword });
    res.json({ data: { updated: true } });
  } catch (error) {
    console.error('Update password failed:', error);
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

export default router;