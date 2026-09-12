import { Router } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { logAction } from '../services/auditLog';

const router = Router();
router.use(requireAuth, requireOfficial);

function scopedUsersQuery(req: AuthenticatedRequest) {
  const usersRef = db.collection('users');
  if (req.user!.role === 'LGU_ADMIN') return usersRef;
  return usersRef.where('barangayId', '==', req.user!.barangayId);
}

// GET /users
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await scopedUsersQuery(req).get();
    const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: users });
  } catch (error) {
    console.error('List users failed:', error);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// POST /users — gumawa ng bagong Barangay Official / LGU Admin account
router.post('/', async (req: AuthenticatedRequest, res) => {
  const { email, name, role, barangayId, password } = req.body ?? {};

  if (!email || !name || !role || !password) {
    return res.status(400).json({ error: 'email, name, role, and password are required.' });
  }
  if (!['BARANGAY_OFFICIAL', 'LGU_ADMIN'].includes(role)) {
    return res.status(400).json({ error: 'role must be BARANGAY_OFFICIAL or LGU_ADMIN.' });
  }
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU admins can create accounts.' });
  }
  if (password.length < 12) {
    return res.status(400).json({ error: 'Password must be at least 12 characters.' });
  }

  try {
    const userRecord = await auth.createUser({ email, password, displayName: name });

    await db.doc(`users/${userRecord.uid}`).set({
      name,
      displayName: name,
      email,
      role,
      barangayId: barangayId ?? null,
      householdId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

        await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'user_created',
      targetType: 'user',
      targetId: userRecord.uid,
      details: { email, role, barangayId: barangayId ?? null },
    });

    res.status(201).json({ data: { id: userRecord.uid, name, email, role, barangayId: barangayId ?? null } });
  } catch (error: any) {
    console.error('Create user failed:', error);
    if (error.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'This email is already registered.' });
    }
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// PATCH /users/:email
router.patch('/:email', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('users').where('email', '==', req.params.email).limit(1).get();
    if (snapshot.empty) return res.status(404).json({ error: 'User not found.' });

    const userDoc = snapshot.docs[0];
    const targetData = userDoc.data();

    if (req.user!.role !== 'LGU_ADMIN' && targetData.barangayId !== req.user!.barangayId) {
      return res.status(403).json({ error: 'You cannot edit users outside your barangay.' });
    }

    const { name, barangayId, role } = req.body ?? {};
    const updates: Record<string, any> = { updatedAt: new Date() };
    if (name) updates.name = name;
    if (barangayId !== undefined) updates.barangayId = barangayId;
    if (role && req.user!.role === 'LGU_ADMIN') updates.role = role;

    await userDoc.ref.update(updates);
    res.json({ data: { id: userDoc.id, ...targetData, ...updates } });
  } catch (error) {
    console.error('Update user failed:', error);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

// DELETE /users/:email
router.delete('/:email', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU admins can delete accounts.' });
  }

  try {
    const snapshot = await db.collection('users').where('email', '==', req.params.email).limit(1).get();
    if (snapshot.empty) return res.status(404).json({ error: 'User not found.' });

    const userDoc = snapshot.docs[0];
        const deletedData = userDoc.data();
    await auth.deleteUser(userDoc.id);
    await userDoc.ref.delete();

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'user_deleted',
      targetType: 'user',
      targetId: userDoc.id,
      details: { email: deletedData.email, role: deletedData.role },
    });

    res.json({ data: { deleted: true } });
  } catch (error) {
    console.error('Delete user failed:', error);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

export default router;