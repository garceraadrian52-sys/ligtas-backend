import { db } from '../config/firebaseAdmin';

export async function logAction(params: {
  actorId: string;
  actorName: string;
  actorRole: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, any>;
}) {
  await db.collection('auditLogs').add({
    ...params,
    timestamp: new Date(),
  }).catch((error) => console.error('Failed to write audit log:', error));
}