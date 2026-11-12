import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { auditActor, logAction } from '../services/auditLog';
import { auth, db } from '../config/firebaseAdmin';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { normalizeRole } from '../services/roles';
import { recordAuthenticatedLogin } from '../services/activityTracking';

const router = Router();
const FIREBASE_WEB_API_KEY = process.env.FIREBASE_WEB_API_KEY;

function friendlyAuthError(message: string) {
  if (['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS'].includes(message)) {
    return 'Invalid email or password.';
  }
  if (message === 'USER_DISABLED') return 'This account has been disabled.';
  if (message.startsWith('TOO_MANY_ATTEMPTS')) return 'Too many attempts. Please try again later.';
  return 'Login failed. Please try again.';
}

router.post('/forgot-password', async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== 'string' || !email.trim() || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!FIREBASE_WEB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FIREBASE_WEB_API_KEY configuration.' });
  }

  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: email.trim() }),
      },
    );
    const result: any = await response.json();
    const providerError = String(result?.error?.message ?? '');
    // Do not disclose whether a particular address has a LigTAS account.
    if (['EMAIL_NOT_FOUND', 'USER_DISABLED', 'INVALID_EMAIL', 'TOO_MANY_ATTEMPTS_TRY_LATER'].includes(providerError)) {
      return res.status(202).json({ data: { accepted: true } });
    }
    if (!response.ok) {
      console.error('Firebase password reset request failed:', providerError || response.status);
      return res.status(503).json({ error: 'Password reset is temporarily unavailable. Please try again later.' });
    }
    await logAction({actorId:'',actorName:'Not recorded',actorRole:'UNAUTHENTICATED',action:'password_reset_requested',targetType:'user',targetId:'',details:{source:'authentication_provider'}});
    return res.status(202).json({ data: { accepted: true } });
  } catch (error) {
    console.error('Password reset request failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    return res.status(503).json({ error: 'Password reset is temporarily unavailable. Please try again later.' });
  }
});

router.post(['/login','/mobile-login'], async (req, res) => {
  const { identifier, email: emailField, password } = req.body ?? {};
  const email = identifier ?? emailField;

  if (typeof email !== 'string' || !email.trim() || email.length > 320 || typeof password !== 'string' || !password || password.length > 4096) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (!FIREBASE_WEB_API_KEY) {
    return res.status(500).json({ error: 'Server is missing FIREBASE_WEB_API_KEY configuration.' });
  }

  try {
    const signInResponse = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
      },
    );
    const signInData: any = await signInResponse.json();

    if (!signInResponse.ok) {
      const message = signInData?.error?.message ?? 'Invalid credentials.';
      return res.status(401).json({ error: friendlyAuthError(message) });
    }

    const uid = signInData.localId;
    const profileSnap = await db.doc(`users/${uid}`).get();
    const profile = profileSnap.data();

    if (!profile) {
      return res.status(401).json({ error: 'Account profile not found.' });
    }

    const role = normalizeRole(profile.role);
    if (profile.disabled === true) return res.status(403).json({error:'This account has been deactivated.'});
    const mobile=req.path === '/mobile-login';
    if (!mobile && !['LGU_ADMIN', 'SUPER_ADMIN'].includes(role)) {
      return res.status(403).json({ error: 'Only Super Admin or LGU/MDRRMO personnel can access the LigTAS web dashboard.' });
    }

    try {
      const verifiedToken = await auth.verifyIdToken(signInData.idToken);
      if (!mobile && verifiedToken.uid === uid) await recordAuthenticatedLogin(uid, verifiedToken.auth_time);
    } catch (activityError: any) {
      // Keep a valid sign-in available if activity logging is temporarily unavailable.
      console.error('Record web login failed:', activityError?.code ?? 'unknown');
    }

    return res.json({
      data: {
        token: mobile ? await auth.createCustomToken(uid) : signInData.idToken,
        user: {
          id: uid,
          name: profile.name ?? profile.displayName ?? '',
          email: profile.email ?? email,
          role,
          barangayId: profile.barangayId ?? null,
        },
      },
    });
  } catch (error) {
    console.error('Login failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    return res.status(503).json({ error: 'Sign-in is temporarily unavailable. Please try again.' });
  }
});

router.post('/logout',requireAuth,async(req:AuthenticatedRequest,res)=>{
  try {
    await auth.revokeRefreshTokens(req.user!.uid);
    await logAction({...auditActor(req.user!),action:'logout',targetType:'user',targetId:req.user!.uid,eventId:'logout:'+req.user!.uid+':'+req.user!.authTime});
    res.status(204).end();
  } catch {res.status(503).json({error:'Unable to end the server session.'});}
});
export default router;
