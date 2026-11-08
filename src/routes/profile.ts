import { Router } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { Timestamp } from 'firebase-admin/firestore';

const router = Router();
router.use(requireAuth);

// GET /profile
router.get('/', (req: AuthenticatedRequest, res) => {
  const user = req.user!;
  res.json({ data: { id: user.uid, ...req.profile! } });
});

// PATCH /profile
router.patch('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { name, phone, address } = req.body ?? {};
    const updates: Record<string, any> = { updatedAt: Timestamp.now() };
    if (name) { updates.name = name; updates.displayName = name; }
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;

    await db.doc(`users/${req.user!.uid}`).update(updates);
    res.json({ data: { id: req.user!.uid, ...req.profile!, ...updates } });
  } catch (error) {
    console.error('Update profile failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// PATCH /profile/password
router.patch('/password', async (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || newPassword.length < 12) {
    return res.status(400).json({ error: 'Enter your current password and a new password with at least 12 characters.' });
  }
  const webApiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!webApiKey) return res.status(503).json({ error: 'Password changes are temporarily unavailable.' });

  try {
    const firebaseUser = await auth.getUser(req.user!.uid);
    if (!firebaseUser.email) return res.status(400).json({ error: 'This account does not have an email password to update.' });
    const verification = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webApiKey}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: firebaseUser.email, password: currentPassword, returnSecureToken: false }),
      },
    );
    if (!verification.ok) {
      return res.status(400).json({ error: 'Your current password is incorrect.' });
    }
    await auth.updateUser(req.user!.uid, { password: newPassword });
    res.json({ data: { updated: true } });
  } catch (error) {
    if ((error as any)?.code === 'auth/weak-password') {
      return res.status(400).json({ error: 'Choose a stronger password with at least 12 characters.' });
    }
    console.error('Update password failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update password.' });
  }
});

export default router;
