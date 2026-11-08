import { db } from '../config/firebaseAdmin';
import { invalidateFirestoreReadCache } from './firestoreReadCache';

export async function logAction(params: {
  actorId: string;
  actorName: string;
  actorRole: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, any>;
}) {
  await db.collection('auditLogs').add({
    ...params,
    timestamp: new Date(),
  }).then(() => invalidateFirestoreReadCache('auditLogs:')).catch((error) => console.error('Failed to write audit log:', error));
}
