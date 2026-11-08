import { Router } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { Timestamp } from 'firebase-admin/firestore';
import { firebaseAuthPhotoUrl, isValidEmail, isValidProfilePhoto } from '../services/profileFields';
import { validDocumentId, validText } from '../services/inputValidation';

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
    const body = req.body ?? {};
    const allowedFields = ['name', 'email', 'phone', 'address', 'barangayId', 'photoURL'];
    if (Object.keys(body).some(key => !allowedFields.includes(key))) {
      return res.status(400).json({ error: 'One or more profile fields are not supported.' });
    }
    const { name, email, phone, address, barangayId, photoURL } = body;
    if (name !== undefined && !validText(name, 200)) return res.status(400).json({ error: 'Enter a valid full name.' });
    if (email !== undefined && !isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (phone !== undefined && (typeof phone !== 'string' || phone.length > 40)) return res.status(400).json({ error: 'Enter a valid phone number.' });
    if (address !== undefined && (typeof address !== 'string' || address.length > 300)) return res.status(400).json({ error: 'Enter a valid address.' });
    if (barangayId !== undefined && barangayId !== null && !validDocumentId(barangayId)) return res.status(400).json({ error: 'Invalid barangay ID.' });
    if (req.user!.role === 'BARANGAY_OFFICIAL' && barangayId === null) return res.status(400).json({ error: 'A barangay assignment is required for official accounts.' });
    if (req.user!.role === 'BARANGAY_OFFICIAL' && barangayId !== undefined && barangayId !== req.user!.barangayId) {
      return res.status(403).json({ error: 'Barangay Officials cannot change their own assignment.' });
    }
    if (photoURL !== undefined && !isValidProfilePhoto(photoURL)) return res.status(400).json({ error: 'Choose a valid profile image.' });
    if (typeof barangayId === 'string' && barangayId !== req.user!.barangayId && !(await db.doc(`barangays/${barangayId}`).get()).exists) {
      return res.status(400).json({ error: 'Barangay does not exist.' });
    }

    const updates: Record<string, any> = { updatedAt: Timestamp.now() };
    if (name !== undefined) { updates.name = name.trim(); updates.displayName = name.trim(); }
    if (email !== undefined) updates.email = email.trim().toLowerCase();
    if (phone !== undefined) updates.phone = phone;
    if (address !== undefined) updates.address = address;
    if (barangayId !== undefined) updates.barangayId = barangayId;
    if (photoURL !== undefined) updates.photoURL = photoURL;

    const authUpdates: Record<string, unknown> = {};
    if (name !== undefined) authUpdates.displayName = name.trim();
    if (email !== undefined && email.trim().toLowerCase() !== String(req.profile?.email ?? '').toLowerCase()) authUpdates.email = email.trim().toLowerCase();
    const hostedPhotoURL = firebaseAuthPhotoUrl(photoURL);
    if (hostedPhotoURL) authUpdates.photoURL = hostedPhotoURL;
    if (Object.keys(authUpdates).length) await auth.updateUser(req.user!.uid, authUpdates);

    await db.doc(`users/${req.user!.uid}`).update(updates);
    res.json({ data: { id: req.user!.uid, ...req.profile!, ...updates } });
  } catch (error) {
    console.error('Update profile failed:', error);
    if ((error as any)?.code === 'auth/email-already-exists') return res.status(409).json({ error: 'This email is already registered.' });
    if ((error as any)?.code === 'auth/invalid-email') return res.status(400).json({ error: 'Enter a valid email address.' });
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
