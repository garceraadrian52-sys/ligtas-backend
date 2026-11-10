import { Request, Response, NextFunction } from 'express';
import { auth, db } from '../config/firebaseAdmin';
import { isFirestoreResourceExhausted } from '../services/firestoreErrors';
import { isMunicipalityAdmin, normalizeRole } from '../services/roles';

export interface AuthenticatedRequest extends Request {
  user?: { uid: string; role: string; barangayId: string | null; name: string; email: string; authTime?: number };
  profile?: Record<string, any>;
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  const idToken = header.slice(7).trim();
  if (!idToken) return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  try {
    const decoded = await auth.verifyIdToken(idToken);
    const profileSnap = await db.doc(`users/${decoded.uid}`).get();
    const profile = profileSnap.data();
    if (!profile) return res.status(401).json({ error: 'User profile not found.' });

    const role = normalizeRole(profile.role);
    req.user = {
      uid: decoded.uid,
      role,
      barangayId: profile.barangayId ?? null,
      name: profile.name ?? profile.displayName ?? '',
      email: profile.email ?? decoded.email ?? '',
      authTime: decoded.auth_time,
    };
    req.profile = { ...profile, role };
    next();
  } catch (error: any) {
    const invalidTokenCodes = ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'];
    if (invalidTokenCodes.includes(error?.code)) return res.status(401).json({ error: 'Invalid or expired token.' });
    if (isFirestoreResourceExhausted(error)) res.set('Retry-After', '5');
    console.error('Authentication dependency unavailable:', error?.code ?? 'unknown');
    return res.status(503).json({ error: 'Sign-in verification is temporarily unavailable. Please try again.' });
  }
}

export function requireOfficial(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || (!isMunicipalityAdmin(req.user.role) && req.user.role !== 'BARANGAY_OFFICIAL')) {
    return res.status(403).json({ error: 'This account cannot access administrative operations.' });
  }
  if (req.user.role === 'BARANGAY_OFFICIAL' && (typeof req.user.barangayId !== 'string' || !req.user.barangayId.trim())) {
    return res.status(403).json({ error: 'A barangay assignment is required. Contact your LGU administrator.' });
  }
  next();
}
