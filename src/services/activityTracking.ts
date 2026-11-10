import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';

export const ACTIVITY_WRITE_INTERVAL_MS = 15 * 60 * 1000;
export const ACTIVITY_TRACKED_ROLES = Object.freeze([
  'SUPER_ADMIN', 'LGU_ADMIN', 'BARANGAY_OFFICIAL', 'RESIDENT',
] as const);

export function shouldTrackAuthenticatedActivity(role: string) {
  return (ACTIVITY_TRACKED_ROLES as readonly string[]).includes(role);
}

function timestampMillis(value: any): number | null {
  try {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value?.toMillis === 'function') {
      const millis = value.toMillis();
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value?.toDate === 'function') {
      const date = value.toDate();
      return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : null;
    }
    const seconds = value?._seconds ?? value?.seconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds)) {
      const nanos = value?._nanoseconds ?? value?.nanoseconds ?? 0;
      return Number.isFinite(Number(nanos)) ? seconds * 1000 + Math.floor(Number(nanos) / 1e6) : null;
    }
    if (typeof value === 'string' && value.trim()) {
      const millis = Date.parse(value);
      return Number.isFinite(millis) ? millis : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Use Firebase's verified auth_time, and never move a stored Last Login backward. */
export function nextLastLoginAt(existingValue: unknown, authTimeSeconds?: number): Timestamp | null {
  if (!Number.isFinite(authTimeSeconds) || Number(authTimeSeconds) <= 0) return null;
  const authTimeMs = Math.floor(Number(authTimeSeconds) * 1000);
  const previousMs = timestampMillis(existingValue);
  return previousMs !== null && previousMs >= authTimeMs ? null : Timestamp.fromMillis(authTimeMs);
}

type ActivityWrite = (uid: string, updates: Record<string, unknown>) => Promise<unknown>;
type LoginWrite = (uid: string, authTimeSeconds: number | undefined, includeActivity: boolean) => Promise<boolean>;

export function createActivityRecorder(
  writeActivity: ActivityWrite,
  writeLogin: LoginWrite,
  intervalMs = ACTIVITY_WRITE_INTERVAL_MS,
  clock: () => number = Date.now,
) {
  const lastActivityWrite = new Map<string, number>();
  const pendingByUid = new Map<string, Promise<boolean>>();

  const enqueue = async (uid: string, operation: () => Promise<boolean>) => {
    const previous = pendingByUid.get(uid);
    const request = (previous ? previous.catch(() => false) : Promise.resolve(false)).then(operation);
    pendingByUid.set(uid, request);
    try {
      return await request;
    } finally {
      if (pendingByUid.get(uid) === request) pendingByUid.delete(uid);
    }
  };

  const activityDue = (uid: string, now: number) => {
    const previous = lastActivityWrite.get(uid);
    return previous === undefined || now - previous >= intervalMs;
  };

  const rememberActivity = (uid: string, now: number) => {
    lastActivityWrite.set(uid, now);
    if (lastActivityWrite.size > 50000) {
      for (const [userId, writtenAt] of lastActivityWrite) {
        if (now - writtenAt > intervalMs * 4) lastActivityWrite.delete(userId);
      }
    }
  };

  const recordActivity = (uid: string) => enqueue(uid, async () => {
    const now = clock();
    if (!activityDue(uid, now)) return false;
    await writeActivity(uid, { lastActiveAt: FieldValue.serverTimestamp() });
    rememberActivity(uid, now);
    return true;
  });

  const recordLogin = (uid: string, authTimeSeconds?: number) => enqueue(uid, async () => {
    const now = clock();
    const includeActivity = activityDue(uid, now);
    const recorded = await writeLogin(uid, authTimeSeconds, includeActivity);
    if (includeActivity && recorded) rememberActivity(uid, now);
    return recorded;
  });

  return { recordActivity, recordLogin };
}

const recorder = createActivityRecorder(
  (uid, updates) => db.doc(`users/${uid}`).set(updates, { merge: true }),
  async (uid, authTimeSeconds, includeActivity) => {
    const ref = db.doc(`users/${uid}`);
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const updates: Record<string, unknown> = {};
      const loginAt = nextLastLoginAt(snapshot.get('lastLoginAt'), authTimeSeconds);
      if (loginAt) updates.lastLoginAt = loginAt;
      if (includeActivity) updates.lastActiveAt = FieldValue.serverTimestamp();
      if (Object.keys(updates).length === 0) return false;
      transaction.set(ref, updates, { merge: true });
      return true;
    });
  },
);

export function recordAuthenticatedActivity(uid: string) {
  return recorder.recordActivity(uid);
}

export function recordAuthenticatedLogin(uid: string, authTimeSeconds?: number) {
  return recorder.recordLogin(uid, authTimeSeconds);
}
