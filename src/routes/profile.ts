import { auditActor, logAction } from '../services/auditLog';
import { Router, type Response } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { Timestamp } from 'firebase-admin/firestore';
import { firebaseAuthPhotoUrl, isValidEmail, isValidProfilePhoto } from '../services/profileFields';
import { validDocumentId, validText } from '../services/inputValidation';
import { isMunicipalityAdmin } from '../services/roles';

const router = Router();
router.use(requireAuth);

class IdentityToolkitError extends Error {
  constructor(readonly providerCode: string) {
    super(providerCode);
  }
}

class AccountFlowError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function identityToolkitRequest(endpoint: string, body: Record<string, unknown>) {
  const apiKey = process.env.FIREBASE_WEB_API_KEY;
  if (!apiKey) throw new AccountFlowError('AUTH_NOT_CONFIGURED');
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${endpoint}?key=${apiKey}`, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new IdentityToolkitError(String(result?.error?.message ?? 'UNKNOWN'));
  return result;
}

async function reauthenticateWithPassword(uid: string, currentPassword: string) {
  const account = await auth.getUser(uid);
  if (account.disabled) throw new AccountFlowError('ACCOUNT_DISABLED');
  if (!account.email || !account.providerData?.some(provider => provider.providerId === 'password')) {
    throw new AccountFlowError('PASSWORD_PROVIDER_REQUIRED');
  }
  const result = await identityToolkitRequest('accounts:signInWithPassword', {
    email: account.email,
    password: currentPassword,
    returnSecureToken: true,
  });
  if (result.localId !== uid || typeof result.idToken !== 'string') {
    throw new AccountFlowError('REAUTHENTICATION_FAILED');
  }
  return { account, idToken: result.idToken as string };
}

function accountFlowFailure(res: Response, error: any, operation: 'password' | 'email') {
  if (error instanceof IdentityToolkitError) {
    const code = error.providerCode;
    if (['INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS'].includes(code)) return res.status(400).json({ error: 'Your current password is incorrect.' });
    if (code === 'EMAIL_EXISTS') return res.status(409).json({ error: 'That email address is already in use.' });
    if (code === 'INVALID_EMAIL') return res.status(400).json({ error: 'Enter a valid email address.' });
    if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    if (code === 'USER_DISABLED') return res.status(403).json({ error: 'This account has been disabled.' });
    if (['INVALID_ID_TOKEN', 'TOKEN_EXPIRED', 'CREDENTIAL_TOO_OLD_LOGIN_AGAIN'].includes(code)) return res.status(401).json({ error: 'Your session needs fresh sign-in. Sign in again and retry.' });
    if (code === 'OPERATION_NOT_ALLOWED') return res.status(400).json({ error: 'Email and password sign-in is not enabled for this account.' });
    if (['EXPIRED_OOB_CODE', 'INVALID_OOB_CODE'].includes(code)) return res.status(400).json({ error: 'The verification link expired or is no longer valid. Request a new link.' });
  }
  if (error instanceof AccountFlowError) {
    if (error.code === 'AUTH_NOT_CONFIGURED') return res.status(503).json({ error: 'Account changes are temporarily unavailable.' });
    if (error.code === 'ACCOUNT_DISABLED') return res.status(403).json({ error: 'This account has been disabled.' });
    if (error.code === 'PASSWORD_PROVIDER_REQUIRED') return res.status(400).json({ error: 'This account does not use an email and password sign-in. Use its linked sign-in provider.' });
    if (error.code === 'REAUTHENTICATION_FAILED') return res.status(401).json({ error: 'Your current sign-in could not be reauthenticated. Sign in again and retry.' });
  }
  console.error(`Account ${operation} operation failed:`, error?.code ?? error?.providerCode ?? 'unknown');
  if (respondToFirestoreResourceExhausted(res, error)) return true;
  res.status(503).json({ error: 'Firebase Authentication is temporarily unavailable. Please try again.' });
  return true;
}

async function syncVerifiedPendingEmail(uid: string, profile: Record<string, any>) {
  const pendingEmail = typeof profile.pendingEmail === 'string' ? profile.pendingEmail.trim().toLowerCase() : '';
  if (!pendingEmail) return profile;
  try {
    const account = await auth.getUser(uid);
    if (!account.emailVerified || account.email?.trim().toLowerCase() !== pendingEmail) return profile;
    const updates = {
      email: account.email.trim().toLowerCase(),
      pendingEmail: null,
      pendingEmailRequestedAt: null,
      updatedAt: Timestamp.now(),
    };
    await db.doc(`users/${uid}`).update(updates);
    return { ...profile, ...updates };
  } catch (error: any) {
    console.error('Sync verified profile email failed:', error?.code ?? 'unknown');
    return profile;
  }
}

// GET /profile. A pending email is synchronized only after Firebase confirms it.
router.get('/', async (req: AuthenticatedRequest, res) => {
  const profile = await syncVerifiedPendingEmail(req.user!.uid, req.profile!);
  res.json({ data: { id: req.user!.uid, ...profile, email: profile.email ?? req.user!.email, role: req.user!.role } });
});

// PATCH /profile. Email changes must use the verified workflow below.
router.patch('/', async (req: AuthenticatedRequest, res) => {
  try {
    const body = req.body ?? {};
    const allowedFields = ['name', 'phone', 'address', 'barangayId', 'photoURL'];
    if (Object.keys(body).some(key => !allowedFields.includes(key))) {
      return res.status(400).json({ error: 'Email and role changes use separate authorized workflows.' });
    }
    const { name, phone, address, barangayId, photoURL } = body;
    if (name !== undefined && !validText(name, 200)) return res.status(400).json({ error: 'Enter a valid full name.' });
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
    // Empty optional fields do not erase a previously saved value by accident.
    if (phone !== undefined && (phone.trim() || !String(req.profile?.phone ?? '').trim())) updates.phone = phone.trim();
    if (address !== undefined && (address.trim() || !String(req.profile?.address ?? '').trim())) updates.address = address.trim();
    if (barangayId !== undefined) updates.barangayId = barangayId;
    if (photoURL !== undefined) updates.photoURL = photoURL;

    const authUpdates: Record<string, unknown> = {};
    if (name !== undefined) authUpdates.displayName = name.trim();
    const hostedPhotoURL = firebaseAuthPhotoUrl(photoURL);
    if (hostedPhotoURL) authUpdates.photoURL = hostedPhotoURL;
    if (Object.keys(authUpdates).length) await auth.updateUser(req.user!.uid, authUpdates);

    await db.doc(`users/${req.user!.uid}`).update(updates);
    await logAction({...auditActor(req.user!),action:'profile_updated',targetType:'user',targetId:req.user!.uid,details:{changedFields:Object.keys(updates).filter(key=>key!=='updatedAt')}});
    res.json({ data: { id: req.user!.uid, ...req.profile!, ...updates, email: req.profile?.email ?? req.user!.email, role: req.user!.role } });
  } catch (error) {
    console.error('Update profile failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// POST /profile/email/change. Reauthenticate, then ask Firebase to verify the new address.
router.post('/email/change', async (req: AuthenticatedRequest, res) => {
  if (!isMunicipalityAdmin(req.user!.role)) return res.status(403).json({ error: 'Only Super Admin or LGU Admin can change an administrative account email.' });
  const { currentPassword, newEmail: emailInput } = req.body ?? {};
  if (typeof currentPassword !== 'string' || !currentPassword || !isValidEmail(emailInput)) {
    return res.status(400).json({ error: 'Enter your current password and a valid new email address.' });
  }
  const newEmail = emailInput.trim().toLowerCase();
  if (!process.env.FIREBASE_WEB_API_KEY) return res.status(503).json({ error: 'Account changes are temporarily unavailable.' });
  try {
    const { account, idToken } = await reauthenticateWithPassword(req.user!.uid, currentPassword);
    if (newEmail === account.email?.trim().toLowerCase()) return res.status(400).json({ error: 'Enter a different email address.' });
    await identityToolkitRequest('accounts:sendOobCode', {
      requestType: 'VERIFY_AND_CHANGE_EMAIL',
      idToken,
      newEmail,
    });
    const timestamp = Timestamp.now();
    await db.doc(`users/${req.user!.uid}`).update({ pendingEmail: newEmail, pendingEmailRequestedAt: timestamp, updatedAt: timestamp });
    res.json({ data: { pending: true, email: account.email ?? req.user!.email, pendingEmail: newEmail } });
  } catch (error: any) {
    if (accountFlowFailure(res, error, 'email')) return;
  }
});

// POST /profile/email/sync. The new address is copied into Firestore only after Firebase verifies it.
router.post('/email/sync', async (req: AuthenticatedRequest, res) => {
  if (!isMunicipalityAdmin(req.user!.role)) return res.status(403).json({ error: 'Only Super Admin or LGU Admin can synchronize an administrative account email.' });
  const pendingEmail = typeof req.profile?.pendingEmail === 'string' ? req.profile.pendingEmail.trim().toLowerCase() : '';
  if (!pendingEmail) return res.status(409).json({ error: 'There is no pending email change to verify.' });
  try {
    const account = await auth.getUser(req.user!.uid);
    if (!account.emailVerified || account.email?.trim().toLowerCase() !== pendingEmail) {
      return res.status(409).json({ error: 'Firebase has not confirmed the new email yet. Open the verification link, then try again.' });
    }
    const updates = {
      email: account.email.trim().toLowerCase(),
      pendingEmail: null,
      pendingEmailRequestedAt: null,
      updatedAt: Timestamp.now(),
    };
    await db.doc(`users/${req.user!.uid}`).update(updates);
    res.json({ data: { id: req.user!.uid, ...req.profile!, ...updates, role: req.user!.role } });
  } catch (error: any) {
    console.error('Synchronize verified profile email failed:', error?.code ?? 'unknown');
    if (respondToFirestoreResourceExhausted(res, error)) return;
    if (error?.code === 'auth/user-not-found' || error?.code === 'auth/user-disabled') return res.status(403).json({ error: 'This account is no longer available.' });
    res.status(503).json({ error: 'Unable to check the verified email right now. Please try again.' });
  }
});

// PATCH /profile/password. The current password creates a fresh Firebase Auth token before update.
router.patch('/password', async (req: AuthenticatedRequest, res) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || newPassword.length < (isMunicipalityAdmin(req.user!.role) ? 12 : 8) || newPassword.length > 4096) {
    return res.status(400).json({ error: 'Enter your current password and a new password with at least 12 characters.' });
  }
  if (!process.env.FIREBASE_WEB_API_KEY) return res.status(503).json({ error: 'Password changes are temporarily unavailable.' });

  try {
    const { idToken } = await reauthenticateWithPassword(req.user!.uid, currentPassword);
    const result = await identityToolkitRequest('accounts:update', { idToken, password: newPassword, returnSecureToken: true });
    if (result.localId !== req.user!.uid || typeof result.idToken !== 'string') {
      return res.status(503).json({ error: 'Firebase did not confirm the password update.' });
    }
    await logAction({...auditActor(req.user!),action:'password_changed',targetType:'user',targetId:req.user!.uid});
    res.json({ data: { updated: true, token: result.idToken } });
  } catch (error: any) {
    if (error instanceof IdentityToolkitError && error.providerCode === 'WEAK_PASSWORD') {
      return res.status(400).json({ error: 'Choose a stronger password with at least 12 characters.' });
    }
    if (accountFlowFailure(res, error, 'password')) return;
  }
});

export default router;
