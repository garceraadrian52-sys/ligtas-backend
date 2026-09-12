import { Router } from 'express';
import { db } from '../config/firebaseAdmin';

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

router.post('/login', async (req, res) => {
  const { identifier, email: emailField, password } = req.body ?? {};
  const email = identifier ?? emailField;

  if (!email || !password) {
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
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

        const role = String(profile.role ?? 'RESIDENT');
    if (role !== 'LGU_ADMIN') {
      return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can access the LigTAS web dashboard.' });
    }

    return res.json({
      token: signInData.idToken,
      data: {
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
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

export default router;