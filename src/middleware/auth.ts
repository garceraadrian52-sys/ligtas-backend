import { Request, Response, NextFunction } from 'express';
import { auth, db } from '../config/firebaseAdmin';

export interface AuthenticatedRequest extends Request {
  user?: { uid: string; role: string; barangayId: string | null; name: string; email: string };
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  const idToken = header.slice(7);
  try {
    const decoded = await auth.verifyIdToken(idToken);
    const profileSnap = await db.doc(`users/${decoded.uid}`).get();
    const profile = profileSnap.data();
    if (!profile) return res.status(401).json({ error: 'User profile not found.' });

    req.user = {
      uid: decoded.uid,
      role: String(profile.role ?? 'RESIDENT'),
      barangayId: profile.barangayId ?? null,
      name: profile.name ?? profile.displayName ?? '',
      email: profile.email ?? decoded.email ?? '',
    };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

export function requireOfficial(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || !['BARANGAY_OFFICIAL', 'LGU_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only barangay officials or LGU admins can access this.' });
  }
  next();
}