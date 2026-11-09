import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';

export const ACTIVITY_WRITE_INTERVAL_MS = 15 * 60 * 1000;
export const ACTIVITY_TRACKED_ROLES = Object.freeze([
  'SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT',
] as const);

export function shouldTrackAuthenticatedActivity(role: string) {
  return (ACTIVITY_TRACKED_ROLES as readonly string[]).includes(role);
}

type ActivityWrite = (uid: string, updates: Record<string, unknown>) => Promise<unknown>;

export function createActivityRecorder(
  write: ActivityWrite,
  intervalMs = ACTIVITY_WRITE_INTERVAL_MS,
  clock: () => number = Date.now,
) {
  const lastActivityWrite = new Map<string, number>();
  const lastAuthTime = new Map<string, number>();

  return async (uid: string, authTimeSeconds?: number) => {
    const now = clock();
    const authTimeMs = Number.isFinite(authTimeSeconds) && Number(authTimeSeconds) > 0
      ? Math.floor(Number(authTimeSeconds) * 1000)
      : null;
    const writeActivity = now - (lastActivityWrite.get(uid) ?? 0) >= intervalMs;
    const writeLogin = authTimeMs !== null && lastAuthTime.get(uid) !== authTimeMs;
    if (!writeActivity && !writeLogin) return false;

    const updates: Record<string, unknown> = {};
    if (writeActivity) updates.lastActiveAt = FieldValue.serverTimestamp();
    if (writeLogin) updates.lastLoginAt = Timestamp.fromMillis(authTimeMs!);
    await write(uid, updates);
    if (writeActivity) lastActivityWrite.set(uid, now);
    if (writeLogin) lastAuthTime.set(uid, authTimeMs!);
    if (lastActivityWrite.size > 50000) {
      for (const [userId, writtenAt] of lastActivityWrite) {
        if (now - writtenAt > intervalMs * 4) lastActivityWrite.delete(userId);
      }
    }
    return true;
  };
}

const recordActivity = createActivityRecorder((uid, updates) =>
  db.doc(`users/${uid}`).set(updates, { merge: true }),
);

export function recordAuthenticatedActivity(uid: string, authTimeSeconds?: number) {
  return recordActivity(uid, authTimeSeconds);
}
