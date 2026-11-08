import { db } from '../config/firebaseAdmin';
import { cachedFirestoreRead, invalidateFirestoreReadCache } from './firestoreReadCache';

export type ReportRecord = Record<string, any> & { id: string };

/** Shared short-lived report reads keep dashboards, maps, analytics and lists from repeating the same query. */
export function listReports(barangayId: string | null): Promise<ReportRecord[]> {
  const key = barangayId === null ? 'reports:all' : `reports:barangay:${barangayId}`;
  return cachedFirestoreRead(key, async () => {
    const reports = db.collection('reports');
    const query = barangayId === null ? reports : reports.where('barangayId', '==', barangayId);
    const snapshot = await query.get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  });
}

export function invalidateReportReads(): void {
  invalidateFirestoreReadCache('reports:');
}
