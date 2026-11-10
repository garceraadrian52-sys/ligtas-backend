import { db } from '../config/firebaseAdmin';
import { invalidateFirestoreReadCache } from './firestoreReadCache';
import type { Transaction } from 'firebase-admin/firestore';

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

export function logActionInTransaction(transaction: Transaction, params: {
  actorId: string;
  actorName: string;
  actorRole: string;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, any>;
}) {
  const reference = db.collection('auditLogs').doc();
  transaction.create(reference, { ...params, timestamp: new Date() });
  return reference;
}
