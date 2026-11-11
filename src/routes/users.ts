import { Router, type Response } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { validText, validDocumentId } from '../services/inputValidation';
import { logAction, logActionInTransaction } from '../services/auditLog';
import { invalidateFirestoreReadCache } from '../services/firestoreReadCache';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { firebaseAuthPhotoUrl, isValidEmail, isValidProfilePhoto } from '../services/profileFields';
import { allocateDisplayId } from '../services/recordDisplayIds';
import { normalizeRole, SUPER_ADMIN_ROLE_VALUES } from '../services/roles';
import { recordAuthenticatedActivity, recordAuthenticatedLogin, shouldTrackAuthenticatedActivity } from '../services/activityTracking';

const router = Router();
const accountRoles = ['SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL'] as const;
type AccountRole = typeof accountRoles[number];

function directoryRole(value: unknown): AccountRole | 'RESIDENT' | null {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'resident') return 'RESIDENT';
  const role = normalizeRole(value);
  return accountRoles.includes(role as AccountRole) ? role as AccountRole : null;
}

function accessRequestAccountRole(value: unknown): AccountRole | null {
  const role = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (role === 'barangay_official') return 'BARANGAY_OFFICIAL';
  if (['lgu_staff', 'lgu_admin'].includes(role)) return 'LGU_ADMIN';
  return null;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function readableAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  if (!/^ACC-\d{5,}$/.test(id)) return null;
  const sequence = Number(id.slice('ACC-'.length));
  return Number.isSafeInteger(sequence) && sequence > 0 ? id : null;
}

function accountIdSequence(value: string): number {
  return Number(value.slice('ACC-'.length));
}

async function removeCreatedAuthAccount(uid: string) {
  try {
    await auth.deleteUser(uid);
  } catch (error: unknown) {
    console.error('Could not remove Firebase Auth account after user creation failed:', errorCode(error) ?? 'unknown');
  }
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

// POST /users/login — record an interactive login from the verified Firebase auth_time.
// The request body is ignored; the server derives the UID and time from the ID token.
router.post('/login', async (req: AuthenticatedRequest, res) => {
  if (!shouldTrackAuthenticatedActivity(req.user!.role)) {
    return res.status(403).json({ error: 'This account cannot record application activity.' });
  }
  try {
    await recordAuthenticatedLogin(req.user!.uid, req.user!.authTime);
    res.status(204).end();
  } catch (error: any) {
    console.error('Record authenticated login failed:', error?.code ?? 'unknown');
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(503).json({ error: 'Login could not be recorded. Please retry when connected.' });
  }
});

// POST /users/activity — record authenticated use for the UID in the verified token.
// The request body is intentionally ignored; clients cannot choose an account or timestamp.
router.post('/activity', async (req: AuthenticatedRequest, res) => {
  if (!shouldTrackAuthenticatedActivity(req.user!.role)) {
    return res.status(403).json({ error: 'This account cannot record application activity.' });
  }
  try {
    await recordAuthenticatedActivity(req.user!.uid);
    res.status(204).end();
  } catch (error: any) {
    console.error('Record authenticated activity failed:', error?.code ?? 'unknown');
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(503).json({ error: 'Activity could not be recorded. Please retry when connected.' });
  }
});

// POST /users/account-id — assign a readable ID to the signed-in profile when needed.
// The UID is always taken from the verified Firebase token, never from the request body.
router.post('/account-id', async (req: AuthenticatedRequest, res) => {
  const uid = req.user!.uid;
  const userRef = db.doc(`users/${uid}`);
  try {
    const result = await db.runTransaction(async transaction => {
      const profileSnapshot = await transaction.get(userRef);
      if (!profileSnapshot.exists) return { state: 'missing' as const };
      const profile = profileSnapshot.data() ?? {};
      if (!directoryRole(profile.role)) return { state: 'forbidden' as const };

      const existing = readableAccountId(profile.accountId);
      if (existing) return { state: 'assigned' as const, accountId: existing };
      if (typeof profile.accountId === 'string' && profile.accountId.trim()) return { state: 'manual-review' as const };

      const legacyId = readableAccountId(profile.displayId);
      if (legacyId) {
        const [accountIdOwners, displayIdOwners] = await Promise.all([
          transaction.get(db.collection('users').where('accountId', '==', legacyId)),
          transaction.get(db.collection('users').where('displayId', '==', legacyId)),
        ]);
        const collides = [...accountIdOwners.docs, ...displayIdOwners.docs].some(owner => {
          if (owner.id === uid) return false;
          const ownerData = owner.data();
          const ownerAccountId = readableAccountId(ownerData.accountId);
          return ownerAccountId === legacyId || (!ownerAccountId && readableAccountId(ownerData.displayId) === legacyId);
        });
        if (!collides) {
          const counterRef = db.doc('recordIdCounters/users');
          const counterSnapshot = await transaction.get(counterRef);
          const savedCounter = counterSnapshot.exists ? counterSnapshot.data()?.lastIssued : 0;
          if (typeof savedCounter !== 'number' || !Number.isSafeInteger(savedCounter) || savedCounter < 0) {
            throw new Error('The account ID counter is invalid; refusing to reset it.');
          }
          const lastIssued = savedCounter;
          transaction.update(userRef, { accountId: legacyId, updatedAt: new Date() });
          if (accountIdSequence(legacyId) > lastIssued) {
            transaction.set(counterRef, { prefix: 'ACC-', lastIssued: accountIdSequence(legacyId), updatedAt: new Date() }, { merge: true });
          }
          return { state: 'assigned' as const, accountId: legacyId };
        }
      }

      const accountId = await allocateDisplayId(transaction, db, 'users');
      transaction.update(userRef, {
        accountId,
        ...(!profile.displayId ? { displayId: accountId } : {}),
        updatedAt: new Date(),
      });
      return { state: 'assigned' as const, accountId };
    });

    if (result.state === 'missing') return res.status(404).json({ error: 'Account profile not found.' });
    if (result.state === 'forbidden') return res.status(403).json({ error: 'This account cannot receive a directory ID.' });
    if (result.state === 'manual-review') return res.status(409).json({ error: 'This account has an unrecognized ID that requires administrator review.' });
    return res.json({ data: { accountId: result.accountId } });
  } catch (error) {
    console.error('Assign account ID failed:', errorCode(error) ?? 'unknown');
    if (respondToFirestoreResourceExhausted(res, error)) return;
    return res.status(503).json({ error: 'Account ID is temporarily unavailable.' });
  }
});

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
      .map(doc => {
        const item = doc.data();
        const role = directoryRole(item.role);
        if (!role) return null;
        const accountId = readableAccountId(item.accountId) ?? readableAccountId(item.displayId);
        return {
          id: doc.id,
          accountId,
          displayId: accountId,
          name: item.name ?? item.displayName ?? '',
          displayName: item.displayName ?? item.name ?? '',
          email: item.email ?? item.emailAddress ?? '',
          phone: item.phone ?? item.phoneNumber ?? '',
          position: item.position ?? '',
          ...(role !== 'RESIDENT' ? { photoURL: item.photoURL ?? item.photoUrl ?? null } : {}),
          role,
          barangayId: item.barangayId ?? (role === 'RESIDENT' ? item.barangay ?? null : null),
          disabled: item.disabled === true,
          lastActiveAt: item.lastActiveAt ?? null,
          lastLoginAt: item.lastLoginAt ?? null,
          createdAt: item.createdAt ?? null,
        };
      })
      .filter((user): user is NonNullable<typeof user> => user !== null);
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
  const { email, name, phone, position, photoURL, role, barangayId, password, disabled, accessRequestId } = req.body ?? {};
  if (!isValidEmail(email) || !validText(name, 200) || !validText(password, 4096)) {
    return res.status(400).json({ error: 'Enter a valid email, full name, and initial password.' });
  }
  if (phone !== undefined && (typeof phone !== 'string' || phone.length > 40)) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (position !== undefined && (typeof position !== 'string' || position.length > 120)) return res.status(400).json({ error: 'Enter a valid position.' });
  if (accessRequestId !== undefined && !validDocumentId(accessRequestId)) return res.status(400).json({ error: 'Access request reference is invalid.' });
  if (photoURL !== undefined && !isValidProfilePhoto(photoURL)) return res.status(400).json({ error: 'Choose a valid profile image.' });
  if (!accountRoles.includes(role)) return res.status(400).json({ error: 'Choose Super Admin, LGU Admin, or Barangay Official.' });
  if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters.' });
  if (role === 'BARANGAY_OFFICIAL' && !validDocumentId(barangayId)) return res.status(400).json({ error: 'A valid barangay assignment is required for officials.' });
  if (barangayId != null && !validDocumentId(barangayId)) return res.status(400).json({ error: 'Invalid barangay ID.' });

  try {
    if (barangayId && !(await db.doc(`barangays/${barangayId}`).get()).exists) {
      return res.status(400).json({ error: 'Barangay does not exist.' });
    }

    const accessRequestRef = accessRequestId ? db.doc(`accessRequests/${accessRequestId}`) : null;
    if (accessRequestRef) {
      const accessRequestSnapshot = await accessRequestRef.get();
      if (!accessRequestSnapshot.exists) return res.status(404).json({ error: 'Access request not found.' });
      const accessRequest = accessRequestSnapshot.data()!;
      if (String(accessRequest.status || '').toLowerCase() !== 'pending') return res.status(409).json({ error: 'This access request is no longer pending.' });
      if (accessRequestAccountRole(accessRequest.role) !== role) return res.status(400).json({ error: 'The selected account role does not match the access request.' });
      if (String(accessRequest.email || '').trim().toLowerCase() !== email.trim().toLowerCase()) return res.status(400).json({ error: 'The registered email must match the access request.' });
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
      position: typeof position === 'string' ? position.trim() : '',
      ...(photoURL !== undefined ? { photoURL } : {}),
      householdId: null,
      disabled: disabled === true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let displayId: string;
    try {
      displayId = await db.runTransaction(async transaction => {
        if (accessRequestRef) {
          const requestSnapshot = await transaction.get(accessRequestRef);
          if (!requestSnapshot.exists) throw Object.assign(new Error('Access request not found.'), { code: 'access-request/not-found' });
          const request = requestSnapshot.data()!;
          if (String(request.status || '').toLowerCase() !== 'pending') throw Object.assign(new Error('This access request is no longer pending.'), { code: 'access-request/not-pending' });
          if (accessRequestAccountRole(request.role) !== role) throw Object.assign(new Error('The selected account role does not match the access request.'), { code: 'access-request/role-mismatch' });
          if (String(request.email || '').trim().toLowerCase() !== email.trim().toLowerCase()) throw Object.assign(new Error('The registered email must match the access request.'), { code: 'access-request/email-mismatch' });
        }
        const nextDisplayId = await allocateDisplayId(transaction, db, 'users');
        transaction.create(db.doc(`users/${userRecord.uid}`), { ...profile, accountId: nextDisplayId, displayId: nextDisplayId });
        if (accessRequestRef) {
          const reviewedAt = new Date();
          transaction.update(accessRequestRef, {
            status: 'Approved',
            registeredUserId: userRecord.uid,
            registeredAt: reviewedAt,
            reviewedBy: req.user!.uid,
            reviewedByName: req.user!.name,
            reviewedAt,
            updatedAt: reviewedAt,
          });
          logActionInTransaction(transaction, {
            actorId: req.user!.uid,
            actorName: req.user!.name,
            actorRole: req.user!.role,
            actorEmail: req.user!.email,
            action: 'user_created',
            targetType: 'user',
            targetId: userRecord.uid,
            details: { email: profile.email, role, barangayId: profile.barangayId, accessRequestId },
          });
        }
        return nextDisplayId;
      });
    } catch (profileError) {
      await removeCreatedAuthAccount(userRecord.uid);
      throw profileError;
    }

    if (accessRequestRef) invalidateFirestoreReadCache('auditLogs:');
    try {
      if (!accessRequestRef) {
        await writeAudit(req, 'user_created', userRecord.uid, { email: profile.email, role, barangayId: profile.barangayId });
      }
    } catch (auditError) {
      await db.doc(`users/${userRecord.uid}`).delete().catch(() => {});
      if (accessRequestRef) {
        await accessRequestRef.update({ status: 'Pending', registeredUserId: null, registeredAt: null, reviewedBy: null, reviewedByName: null, reviewedAt: null, updatedAt: new Date() }).catch(() => {});
      }
      await removeCreatedAuthAccount(userRecord.uid);
      throw auditError;
    }
    res.status(201).json({ data: { id: userRecord.uid, ...profile, accountId: displayId, displayId } });
  } catch (error: any) {
    console.error('Create user failed:', error);
    if (error.code === 'auth/email-already-exists') return res.status(409).json({ error: 'This email is already registered.' });
    if (error.code === 'access-request/not-found') return res.status(404).json({ error: 'Access request not found.' });
    if (error.code === 'access-request/not-pending') return res.status(409).json({ error: 'This access request is no longer pending.' });
    if (error.code === 'access-request/role-mismatch') return res.status(400).json({ error: 'The selected account role does not match the access request.' });
    if (error.code === 'access-request/email-mismatch') return res.status(400).json({ error: 'The registered email must match the access request.' });
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
