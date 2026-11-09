import { Router, type Response } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { validText, validDocumentId } from '../services/inputValidation';
import { logAction } from '../services/auditLog';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { firebaseAuthPhotoUrl, isValidEmail, isValidProfilePhoto } from '../services/profileFields';
import { allocateDisplayId } from '../services/recordDisplayIds';
import { normalizeRole, SUPER_ADMIN_ROLE_VALUES } from '../services/roles';

const router = Router();
const accountRoles = ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL'] as const;
type AccountRole = typeof accountRoles[number];

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

async function sendFirebasePasswordReset(email: string) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) throw Object.assign(new Error('AUTH_NOT_CONFIGURED'), { providerCode: 'AUTH_NOT_CONFIGURED' });
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(String(result?.error?.message ?? 'UNKNOWN')), { providerCode: String(result?.error?.message ?? 'UNKNOWN') });
}

router.use(requireAuth);

// GET /users/access — role-aware capabilities for the web account directory.
router.get('/access', async (req: AuthenticatedRequest, res) => {
  if (!['SUPER_ADMIN', 'LGU_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only Super Admin or LGU Admin can access account setup.' });
  }
  try {
    res.json({ data: {
      canView: true,
      canManage: req.user!.role === 'SUPER_ADMIN',
      canBootstrapSuperAdmin: false,
      visibleRoles: req.user!.role === 'SUPER_ADMIN' ? accountRoles : [],
    } });
  } catch (error) {
    console.error('Load user access failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load account permissions.' });
  }
});

// GET /users — Super Admin manages accounts; LGU Admin receives a read-only directory.
router.get('/', async (req: AuthenticatedRequest, res) => {
  if (!['SUPER_ADMIN', 'LGU_ADMIN'].includes(req.user!.role)) return res.status(403).json({ error: 'Only Super Admin or LGU Admin can view the account directory.' });
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs
      .filter(doc => accountRoles.includes(normalizeRole(doc.data().role) as AccountRole))
      .map(doc => {
        const item = doc.data();
        const role = normalizeRole(item.role) as AccountRole;
        return {
          id: doc.id,
          displayId: item.displayId ?? null,
          name: item.name ?? item.displayName ?? '',
          displayName: item.displayName ?? item.name ?? '',
          email: item.email ?? '',
          phone: item.phone ?? '',
          photoURL: item.photoURL ?? item.photoUrl ?? null,
          role,
          barangayId: item.barangayId ?? null,
          disabled: item.disabled === true,
          lastActiveAt: item.lastActiveAt ?? null,
          lastLoginAt: item.lastLoginAt ?? null,
          createdAt: item.createdAt ?? null,
        };
      });
    res.json({ data: users });
  } catch (error) {
    console.error('List users failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load users.' });
  }
});

// POST /users — only Super Admin can create operational accounts.
router.post('/', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only Super Admin can create accounts.' });
  const { email, name, phone, photoURL, role, barangayId, password, disabled } = req.body ?? {};
  if (!isValidEmail(email) || !validText(name, 200) || !validText(password, 4096)) {
    return res.status(400).json({ error: 'Enter a valid email, full name, and initial password.' });
  }
  if (phone !== undefined && (typeof phone !== 'string' || phone.length > 40)) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (photoURL !== undefined && !isValidProfilePhoto(photoURL)) return res.status(400).json({ error: 'Choose a valid profile image.' });
  if (!accountRoles.includes(role)) return res.status(400).json({ error: 'Choose Super Admin, LGU Admin, or Barangay Official.' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters.' });
  if (role === 'BARANGAY_OFFICIAL' && !validDocumentId(barangayId)) return res.status(400).json({ error: 'A valid barangay assignment is required for officials.' });
  if (barangayId != null && !validDocumentId(barangayId)) return res.status(400).json({ error: 'Invalid barangay ID.' });

  try {
    if (barangayId && !(await db.doc(`barangays/${barangayId}`).get()).exists) {
      return res.status(400).json({ error: 'Barangay does not exist.' });
    }

    const hostedPhotoURL = firebaseAuthPhotoUrl(photoURL);
    const userRecord = await auth.createUser({ email: email.trim().toLowerCase(), password, displayName: name.trim(), disabled: disabled === true, ...(hostedPhotoURL ? { photoURL: hostedPhotoURL } : {}) });
    const profile = {
      name: name.trim(),
      displayName: name.trim(),
      email: email.trim().toLowerCase(),
      role: role as AccountRole,
      barangayId: role === 'BARANGAY_OFFICIAL' ? barangayId : null,
      phone: typeof phone === 'string' ? phone.trim() : '',
      ...(photoURL !== undefined ? { photoURL } : {}),
      householdId: null,
      disabled: disabled === true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let displayId: string;
    try {
      displayId = await db.runTransaction(async transaction => {
        const nextDisplayId = await allocateDisplayId(transaction, db, 'users');
        transaction.create(db.doc(`users/${userRecord.uid}`), { ...profile, displayId: nextDisplayId });
        return nextDisplayId;
      });
    } catch (profileError) {
      await auth.deleteUser(userRecord.uid).catch(() => {});
      throw profileError;
    }

    try {
      await writeAudit(req, 'user_created', userRecord.uid, { email: profile.email, role, barangayId: profile.barangayId });
    } catch (auditError) {
      await db.doc(`users/${userRecord.uid}`).delete().catch(() => {});
      await auth.deleteUser(userRecord.uid).catch(() => {});
      throw auditError;
    }
    res.status(201).json({ data: { id: userRecord.uid, ...profile, displayId } });
  } catch (error: any) {
    console.error('Create user failed:', error);
    if (error.code === 'auth/email-already-exists') return res.status(409).json({ error: 'This email is already registered.' });
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// POST /users/:userId/password-reset — send Firebase's secure reset link to another staff member.
router.post('/:userId/password-reset', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Only Super Admin can request password resets for other staff accounts.' });
  const userId = req.params.userId;
  if (!validDocumentId(userId)) return res.status(400).json({ error: 'Invalid user ID.' });
  if (userId === req.user!.uid) return res.status(400).json({ error: 'Use your own verified password workflow in Settings.' });
  if (!process.env.FIREBASE_WEB_API_KEY) return res.status(503).json({ error: 'Password reset is temporarily unavailable.' });
  try {
    const profileSnapshot = await db.doc(`users/${userId}`).get();
    if (!profileSnapshot.exists) return res.status(404).json({ error: 'User not found.' });
    if (!accountRoles.includes(normalizeRole(profileSnapshot.data()?.role) as AccountRole)) {
      return res.status(403).json({ error: 'Resident accounts are not managed in this directory.' });
    }
    const target = await auth.getUser(userId);
    if (target.disabled) return res.status(403).json({ error: 'This account has been disabled.' });
    if (!target.email || !target.providerData?.some(provider => provider.providerId === 'password')) {
      return res.status(400).json({ error: 'This account does not use email and password sign-in.' });
    }
    await sendFirebasePasswordReset(target.email);
    await writeAudit(req, 'user_password_reset_requested', userId, { displayId: profileSnapshot.data()?.displayId ?? null })
      .catch(error => console.error('Record password reset audit failed:', (error as any)?.code ?? 'unknown'));
    res.json({ data: { sent: true } });
  } catch (error: any) {
    const code = String(error?.providerCode ?? error?.code ?? '');
    if (code === 'auth/user-not-found' || code === 'EMAIL_NOT_FOUND') return res.status(404).json({ error: 'User not found.' });
    if (code === 'auth/user-disabled' || code === 'USER_DISABLED') return res.status(403).json({ error: 'This account has been disabled.' });
    if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return res.status(429).json({ error: 'Too many reset requests. Please try again later.' });
    if (code === 'AUTH_NOT_CONFIGURED') return res.status(503).json({ error: 'Password reset is temporarily unavailable.' });
    console.error('Staff password reset request failed:', code || 'unknown');
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(503).json({ error: 'Password reset is temporarily unavailable. Please try again.' });
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
    if (!accountRoles.includes(normalizeRole(current.role) as AccountRole)) return res.status(403).json({ error: 'Resident profiles are not managed in this directory.' });

    const { name, email, phone, photoURL, role, barangayId, disabled } = req.body ?? {};
    const nextRole = role ?? normalizeRole(current.role);
    if (!accountRoles.includes(nextRole)) return res.status(400).json({ error: 'Choose Super Admin, LGU Admin, or Barangay Official.' });
    const nextBarangay = nextRole === 'BARANGAY_OFFICIAL' ? (barangayId === undefined ? current.barangayId : barangayId) : null;
    if (nextRole === 'BARANGAY_OFFICIAL' && !validDocumentId(nextBarangay)) return res.status(400).json({ error: 'A valid barangay assignment is required for officials.' });
    if (nextBarangay && !(await db.doc(`barangays/${nextBarangay}`).get()).exists) return res.status(400).json({ error: 'Barangay does not exist.' });
    if (name !== undefined && !validText(name, 200)) return res.status(400).json({ error: 'Enter a valid full name.' });
    if (email !== undefined && !isValidEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (email !== undefined && email.trim().toLowerCase() !== String(current.email ?? '').toLowerCase()) {
      return res.status(400).json({ error: 'Email changes must be requested through the account holder’s verified workflow in Settings.' });
    }
    if (phone !== undefined && (typeof phone !== 'string' || phone.length > 40)) return res.status(400).json({ error: 'Enter a valid phone number.' });
    if (photoURL !== undefined && !isValidProfilePhoto(photoURL)) return res.status(400).json({ error: 'Choose a valid profile image.' });
    if (disabled !== undefined && typeof disabled !== 'boolean') return res.status(400).json({ error: 'Account status is invalid.' });
    if (userId === req.user!.uid && (disabled === true || nextRole !== 'SUPER_ADMIN')) return res.status(400).json({ error: 'You cannot disable or change your own Super Admin account.' });
    if (normalizeRole(current.role) === 'SUPER_ADMIN' && (nextRole !== 'SUPER_ADMIN' || disabled === true) && await countOtherActiveSuperAdmins(userId) === 0) {
      return res.status(409).json({ error: 'Keep at least one active Super Admin account.' });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date(), role: nextRole, barangayId: nextBarangay ?? null };
    if (name !== undefined) { updates.name = name.trim(); updates.displayName = name.trim(); }
    if (phone !== undefined) updates.phone = phone.trim();
    if (photoURL !== undefined) updates.photoURL = photoURL;
    if (disabled !== undefined) updates.disabled = disabled;
    const authUpdates: Record<string, unknown> = {};
    if (name !== undefined) authUpdates.displayName = name.trim();
    const hostedPhotoURL = firebaseAuthPhotoUrl(photoURL);
    if (hostedPhotoURL) authUpdates.photoURL = hostedPhotoURL;
    if (disabled !== undefined) authUpdates.disabled = disabled;
    if (Object.keys(authUpdates).length) await auth.updateUser(userId, authUpdates);
    await userRef.update(updates);
    await writeAudit(req, 'user_updated', userId, { email: current.email, previousRole: current.role, role: nextRole, disabled: disabled ?? current.disabled ?? false, barangayId: nextBarangay ?? null });
    const updated = await userRef.get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update user failed:', error);
    if ((error as any)?.code === 'auth/email-already-exists') return res.status(409).json({ error: 'This email is already registered.' });
    if ((error as any)?.code === 'auth/invalid-email') return res.status(400).json({ error: 'Enter a valid email address.' });
    if (respondToFirestoreResourceExhausted(res, error)) return;
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
    const role = normalizeRole(data.role) as AccountRole;
    if (!accountRoles.includes(role)) return res.status(403).json({ error: 'Resident accounts are not deleted from this directory.' });
    if (role === 'SUPER_ADMIN' && await countOtherActiveSuperAdmins(userId) === 0) return res.status(409).json({ error: 'Keep at least one active Super Admin account.' });
    await auth.deleteUser(userId);
    await userRef.delete();
    await writeAudit(req, 'user_deleted', userId, { email: data.email, role: data.role });
    res.json({ data: { deleted: true } });
  } catch (error) {
    console.error('Delete user failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to delete user.' });
  }
});

async function countOtherActiveSuperAdmins(exceptUserId: string) {
  const snapshot = await db.collection('users').where('role', 'in', SUPER_ADMIN_ROLE_VALUES).get();
  return snapshot.docs.filter(doc => doc.id !== exceptUserId && normalizeRole(doc.data().role) === 'SUPER_ADMIN' && doc.data().disabled !== true).length;
}

export default router;
