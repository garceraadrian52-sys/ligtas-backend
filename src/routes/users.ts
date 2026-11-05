import { Router, type Response } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { validText, validDocumentId } from '../services/inputValidation';
import { logAction } from '../services/auditLog';

const router = Router();
const accountRoles = ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL'] as const;
type AccountRole = typeof accountRoles[number];
const bootstrapRef = db.doc('systemSettings/superAdminBootstrap');

async function hasActiveSuperAdmin() {
  const snapshot = await db.collection('users').where('role', '==', 'SUPER_ADMIN').get();
  return snapshot.docs.some(doc => doc.data().disabled !== true);
}

async function writeAudit(req: AuthenticatedRequest, action: string, targetId: string, details: Record<string, unknown>) {
  await logAction({
    actorId: req.user!.uid,
    actorName: req.user!.name,
    actorRole: req.user!.role,
    actorEmail: req.user!.email,
    action,
    targetType: 'user',
    targetId,
    details,
  });
}

router.use(requireAuth);

// GET /users/access — role-aware capabilities for the web account directory.
router.get('/access', async (req: AuthenticatedRequest, res) => {
  if (!['SUPER_ADMIN', 'LGU_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only Super Admin or LGU Admin can access account setup.' });
  }
  try {
    const isSuperAdmin = req.user!.role === 'SUPER_ADMIN';
    const hasSuperAdmin = await hasActiveSuperAdmin();
    res.json({ data: {
      canManage: isSuperAdmin,
      canBootstrapSuperAdmin: req.user!.role === 'LGU_ADMIN' && !hasSuperAdmin,
      visibleRoles: isSuperAdmin ? accountRoles : hasSuperAdmin ? [] : ['SUPER_ADMIN'],
    } });
  } catch (error) {
    console.error('Load user access failed:', error);
    res.status(500).json({ error: 'Failed to load account permissions.' });
  }
});

// GET /users — residents stay in Firestore for the mobile app, but are not part of this directory.
router.get('/', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only Super Admin can view system accounts.' });
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter((item: any) => accountRoles.includes(item.role));
    res.json({ data: users });
  } catch (error) {
    console.error('List users failed:', error);
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// POST /users — Super Admin creates operational accounts. An LGU Admin may bootstrap
// the first Super Admin so an existing installation can migrate safely.
router.post('/', async (req: AuthenticatedRequest, res) => {
  const { email, name, role, barangayId, password, disabled } = req.body ?? {};
  if (!validText(email, 320) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || !validText(name, 200) || !validText(password, 4096)) {
    return res.status(400).json({ error: 'Enter a valid email, full name, and initial password.' });
  }
  if (!accountRoles.includes(role)) return res.status(400).json({ error: 'Choose Super Admin, LGU Admin, or Barangay Official.' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters.' });
  if (role === 'BARANGAY_OFFICIAL' && !validDocumentId(barangayId)) return res.status(400).json({ error: 'A valid barangay assignment is required for officials.' });
  if (barangayId != null && !validDocumentId(barangayId)) return res.status(400).json({ error: 'Invalid barangay ID.' });

  const isSuperAdmin = req.user!.role === 'SUPER_ADMIN';
  const isBootstrap = req.user!.role === 'LGU_ADMIN' && role === 'SUPER_ADMIN';
  if (!isSuperAdmin && !isBootstrap) return res.status(403).json({ error: 'Only Super Admin can create accounts. The LGU Admin can create the initial Super Admin account.' });
  if (isBootstrap && await hasActiveSuperAdmin()) return res.status(403).json({ error: 'A Super Admin account already exists. Only a Super Admin can create more accounts.' });

  try {
    if (barangayId && !(await db.doc(`barangays/${barangayId}`).get()).exists) {
      return res.status(400).json({ error: 'Barangay does not exist.' });
    }

    const userRecord = await auth.createUser({ email: email.trim(), password, displayName: name.trim(), disabled: disabled === true });
    const profile = {
      name: name.trim(),
      displayName: name.trim(),
      email: email.trim().toLowerCase(),
      role: role as AccountRole,
      barangayId: role === 'BARANGAY_OFFICIAL' ? barangayId : null,
      householdId: null,
      disabled: disabled === true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    try {
      if (isBootstrap) {
        await db.runTransaction(async transaction => {
          const lock = await transaction.get(bootstrapRef);
          if (lock.exists) throw Object.assign(new Error('A Super Admin account has already been bootstrapped.'), { code: 'super-admin-exists' });
          transaction.create(bootstrapRef, { userId: userRecord.uid, createdAt: new Date() });
          transaction.create(db.doc(`users/${userRecord.uid}`), profile);
        });
      } else {
        await db.doc(`users/${userRecord.uid}`).set(profile);
      }
    } catch (error) {
      await auth.deleteUser(userRecord.uid).catch(() => {});
      throw error;
    }

    await writeAudit(req, 'user_created', userRecord.uid, { email: profile.email, role, barangayId: profile.barangayId });
    res.status(201).json({ data: { id: userRecord.uid, ...profile } });
  } catch (error: any) {
    console.error('Create user failed:', error);
    if (error.code === 'auth/email-already-exists') return res.status(409).json({ error: 'This email is already registered.' });
    if (error.code === 'super-admin-exists') return res.status(409).json({ error: error.message });
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// PATCH /users/:userId — account permissions and status are controlled by Super Admin.
router.patch('/:userId', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only Super Admin can edit system accounts.' });
  const userId = req.params.userId;
  if (!validDocumentId(userId)) return res.status(400).json({ error: 'Invalid user ID.' });
  try {
    const userRef = db.doc(`users/${userId}`);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'User not found.' });
    const current = snapshot.data()!;
    if (!accountRoles.includes(current.role)) return res.status(403).json({ error: 'Resident profiles are not managed in this directory.' });

    const { name, role, barangayId, disabled } = req.body ?? {};
    const nextRole = role ?? current.role;
    if (!accountRoles.includes(nextRole)) return res.status(400).json({ error: 'Choose Super Admin, LGU Admin, or Barangay Official.' });
    const nextBarangay = nextRole === 'BARANGAY_OFFICIAL' ? (barangayId === undefined ? current.barangayId : barangayId) : null;
    if (nextRole === 'BARANGAY_OFFICIAL' && !validDocumentId(nextBarangay)) return res.status(400).json({ error: 'A valid barangay assignment is required for officials.' });
    if (nextBarangay && !(await db.doc(`barangays/${nextBarangay}`).get()).exists) return res.status(400).json({ error: 'Barangay does not exist.' });
    if (name !== undefined && !validText(name, 200)) return res.status(400).json({ error: 'Enter a valid full name.' });
    if (disabled !== undefined && typeof disabled !== 'boolean') return res.status(400).json({ error: 'Account status is invalid.' });
    if (userId === req.user!.uid && (disabled === true || nextRole !== 'SUPER_ADMIN')) return res.status(400).json({ error: 'You cannot disable or change your own Super Admin account.' });
    if (current.role === 'SUPER_ADMIN' && (nextRole !== 'SUPER_ADMIN' || disabled === true) && await countOtherActiveSuperAdmins(userId) === 0) {
      return res.status(409).json({ error: 'Keep at least one active Super Admin account.' });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date(), role: nextRole, barangayId: nextBarangay ?? null };
    if (name !== undefined) { updates.name = name.trim(); updates.displayName = name.trim(); }
    if (disabled !== undefined) updates.disabled = disabled;
    const authUpdates: Record<string, unknown> = {};
    if (name !== undefined) authUpdates.displayName = name.trim();
    if (disabled !== undefined) authUpdates.disabled = disabled;
    if (Object.keys(authUpdates).length) await auth.updateUser(userId, authUpdates);
    await userRef.update(updates);
    await writeAudit(req, 'user_updated', userId, { email: current.email, previousRole: current.role, role: nextRole, disabled: disabled ?? current.disabled ?? false, barangayId: nextBarangay ?? null });
    const updated = await userRef.get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update user failed:', error);
    res.status(500).json({ error: 'Failed to update user.' });
  }
});

router.delete('/:userId', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only Super Admin can delete system accounts.' });
  const userId = req.params.userId;
  if (!validDocumentId(userId)) return res.status(400).json({ error: 'Invalid user ID.' });
  if (userId === req.user!.uid) return res.status(400).json({ error: 'You cannot delete your own account.' });
  try {
    const userRef = db.doc(`users/${userId}`);
    const snapshot = await userRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'User not found.' });
    const data = snapshot.data()!;
    if (!accountRoles.includes(data.role)) return res.status(403).json({ error: 'Resident accounts are not deleted from this directory.' });
    if (data.role === 'SUPER_ADMIN' && await countOtherActiveSuperAdmins(userId) === 0) return res.status(409).json({ error: 'Keep at least one active Super Admin account.' });
    await auth.deleteUser(userId);
    await userRef.delete();
    await writeAudit(req, 'user_deleted', userId, { email: data.email, role: data.role });
    res.json({ data: { deleted: true } });
  } catch (error) {
    console.error('Delete user failed:', error);
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

async function countOtherActiveSuperAdmins(exceptUserId: string) {
  const snapshot = await db.collection('users').where('role', '==', 'SUPER_ADMIN').get();
  return snapshot.docs.filter(doc => doc.id !== exceptUserId && doc.data().disabled !== true).length;
}

export default router;
