import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { resolveReportBarangay } from './reportBarangay';

// Explicit maintenance operation: only pending reports are eligible; attendance and verified history are untouched.
export async function reroutePendingReport(db: Firestore, id: string, apply = false) {
  return db.runTransaction(async tx => {
    const ref = db.doc('reports/' + id), snapshot = await tx.get(ref), report = snapshot.data();
    if (!report || report.status !== 'Pending' || report.verification !== 'Pending') return { id, status: 'skipped', reason: 'Not pending' };
    let area;
    try { area = resolveReportBarangay(report.latitude, report.longitude); }
    catch { return { id, status: 'skipped', reason: 'Location needs review' }; }
    if (report.barangayId === area.id && report.routingVersion === 1) return { id, status: 'unchanged' };
    const roadId = report.roadConditionId;
    if (roadId != null && (typeof roadId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(roadId))) return { id, status: 'skipped', reason: 'Invalid mirror ID' };
    const roadRef = roadId ? db.doc('roadConditions/' + roadId) : null;
    const mirror = roadRef ? (await tx.get(roadRef)).data() : null;
    if (roadRef && (!mirror || mirror.reporterId !== report.reporterId || mirror.verification !== 'Pending' || mirror.reportStatus !== 'Pending')) return { id, status: 'skipped', reason: 'Road mirror needs review' };
    if (apply) {
      const values = { barangayId: area.id, barangayName: area.name, routingVersion: 1, routingSource: 'incident_coordinates', boundarySource: area.boundarySource,
        previousRoutingBarangayId: report.barangayId ?? null, routingCorrectedAt: FieldValue.serverTimestamp() };
      tx.update(ref, values);
      if (roadRef) tx.update(roadRef, values);
    }
    return { id, status: apply ? 'updated' : 'would-update', from: report.barangayId ?? null, to: area.id };
  });
}
