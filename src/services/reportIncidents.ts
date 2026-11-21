import { db } from '../config/firebaseAdmin';
import { isMunicipalityAdmin } from './roles';
import { validDocumentId } from './inputValidation';
import { recordedMillis, reportStatus } from './reportAnalytics';
import { auditActor, logActionInTransaction } from './auditLog';
import { invalidateReportReads } from './reportReads';

type Actor = { uid: string; name: string; role: string; barangayId: string | null };
type RecordData = Record<string, any>;
export class IncidentError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
export function assertReportAccess(actor: Actor, report: RecordData) {
  if (isMunicipalityAdmin(actor.role)) return;
  if (actor.role !== 'BARANGAY_OFFICIAL' || !actor.barangayId || actor.barangayId !== report.barangayId)
    throw new IncidentError('Only the assigned Barangay Official or a municipality administrator can review this report.', 403);
}
const reportType = (record: RecordData) => String(record.type || record.reportType || '').toLowerCase();
function groupable(record: RecordData) {
  const statuses = [record.status, record.verification, record.reportStatus].map(value => String(value || '').toLowerCase());
  return !statuses.some(status => ['resolved', 'rejected', 'denied', 'invalid'].includes(status)) && ['Pending', 'Verified'].includes(reportStatus(record));
}
function point(record: RecordData): number[] | null {
  const source = record.locationPoint || record.coordinates || record;
  const lat = record.latitude ?? source.latitude ?? source.lat ?? source[0];
  const lng = record.longitude ?? source.longitude ?? source.lng ?? source[1];
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}
export function relatedReportDistance(base: RecordData, candidate: RecordData): number | null {
  if (!['flood', 'road'].includes(reportType(base)) || reportType(base) !== reportType(candidate)) return null;
  const a = point(base), b = point(candidate);
  // Use the server-recorded submission time, never an edit/review timestamp.
  const first = recordedMillis(base.createdAt), second = recordedMillis(candidate.createdAt);
  if (!a || !b || first === null || second === null || Math.abs(first - second) > 6 * 3600000) return null;
  const rad = (value: number) => value * Math.PI / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  const metres = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
  return metres <= 250 ? Math.round(metres) : null;
}
export function suggestRelatedReports(base: RecordData, candidates: RecordData[], actor: Actor) {
  assertReportAccess(actor, base);
  return candidates.filter(item => item.id !== base.id && !item.incidentId && !item.submittedByOfficial && groupable(item))
    .flatMap(item => {
      if (!isMunicipalityAdmin(actor.role) && item.barangayId !== actor.barangayId) return [];
      const distanceMetres = relatedReportDistance(base, item);
      return distanceMetres === null ? [] : [{ ...item, distanceMetres }];
    }).sort((a, b) => a.distanceMetres - b.distanceMetres).slice(0, 30);
}

/** Membership, reviews, mirrors and audit events commit together; originals/evidence are untouched. */
export async function changeReportIncident(actor: Actor, anchorId: string, input: RecordData) {
  const operation = input.operation || 'group';
  const admin = isMunicipalityAdmin(actor.role);
  if (!validDocumentId(anchorId) || !['group', 'ungroup', 'resolve'].includes(operation)) throw new IncidentError('Invalid incident operation.', 400);
  if (operation !== 'group' && !admin) throw new IncidentError('Only municipality administrators can change existing incidents.', 403);
  const supplied = input.reportIds;
  if (operation === 'group' && (!Array.isArray(supplied) || supplied.length < 2 || supplied.length > 50 || supplied.some(id => !validDocumentId(id)) || new Set(supplied).size !== supplied.length || !supplied.includes(anchorId)))
    throw new IncidentError('Select 2 to 50 distinct reports, including the current report.', 400);
  const newRef = db.collection('incidents').doc();
  const result = await db.runTransaction(async tx => {
    const anchorRef = db.doc('reports/' + anchorId);
    const anchorSnap = await tx.get(anchorRef);
    if (!anchorSnap.exists) throw new IncidentError('Report not found.', 404);
    const anchor = anchorSnap.data()!;
    assertReportAccess(actor, anchor);
    const incidentRef = anchor.incidentId ? db.doc('incidents/' + anchor.incidentId) : newRef;
    const incidentSnap = anchor.incidentId ? await tx.get(incidentRef) : null;
    const previous = incidentSnap?.data();
    if (anchor.incidentId && !previous) throw new IncidentError('Incident record is unavailable. Refresh and try again.');
    if (previous && !admin) {
      const same = operation === 'group' && [...previous.reportIds].sort().join('|') === [...supplied].sort().join('|');
      if (same && previous.status === 'Verified' && previous.barangayIds?.every((id: string) => id === actor.barangayId)) return { id: incidentRef.id, ...previous };
      throw new IncidentError('Only municipality administrators can change existing incidents.', 403);
    }
    if (operation !== 'group' && !previous) throw new IncidentError('This report is not grouped.');
    if (previous?.status === 'Resolved') {
      if (operation === 'resolve') return { id: incidentRef.id, ...previous };
      throw new IncidentError('Resolved incidents cannot be regrouped.');
    }
    const previousIds: string[] = previous?.reportIds || [];
    const nextIds: string[] = operation === 'group' ? supplied : operation === 'resolve' ? previousIds : [];
    const allIds = [...new Set([anchorId, ...previousIds, ...nextIds])];
    const snapshots = await Promise.all(allIds.map(id => tx.get(db.doc('reports/' + id))));
    const records = snapshots.map(snap => {
      if (!snap.exists) throw new IncidentError('A selected report no longer exists.', 404);
      const record = { ...snap.data(), id: snap.id } as RecordData;
      assertReportAccess(actor, record);
      if (!admin && record.submittedByOfficial) throw new IncidentError('Select resident reports for BO verification.', 403);
      if (record.incidentId && record.incidentId !== incidentRef.id) throw new IncidentError('A report already belongs to another incident. Ungroup it first.');
      if (nextIds.includes(record.id) && !groupable(record)) throw new IncidentError('Only pending or verified reports can be grouped.');
      if (nextIds.includes(record.id) && reportType(record) !== reportType(anchor)) throw new IncidentError('Group reports of the same type.');
      return record;
    });
    if (operation === 'group' && previous && [...previousIds].sort().join('|') === [...nextIds].sort().join('|')) return { id: incidentRef.id, ...previous };
    const mirrors = await Promise.all(records.map(record => record.roadConditionId ? tx.get(db.doc('roadConditions/' + record.roadConditionId)) : null));
    const now = new Date();
    const metadata = { incidentId: operation === 'ungroup' ? null : incidentRef.id, incidentReportCount: nextIds.length, incidentReportIds: nextIds };
    records.forEach((record, index) => {
      const retained = nextIds.includes(record.id);
      const updates: RecordData = { ...(retained ? metadata : { incidentId: null, incidentReportCount: 0, incidentReportIds: [] }), updatedAt: now };
      if (retained && operation === 'group' && reportStatus(record) === 'Pending') {
        Object.assign(updates, { status: 'Verified', verification: 'Verified', reviewedAt: now, reviewedBy: actor.uid, reviewedByName: actor.name, verifiedAt: now, verifiedBy: actor.uid, verifiedByName: actor.name, resolvedAt: null });
        logActionInTransaction(tx, { ...auditActor(actor), action: 'report_verified', targetType: 'report', targetId: record.id, details: { status: 'Verified' } });
      }
      if (retained && operation === 'resolve') {
        if (reportStatus(record) !== 'Verified') throw new IncidentError('All incident reports must be verified before resolution.');
        Object.assign(updates, { status: 'Resolved', verification: 'Resolved', resolvedAt: now, resolvedBy: actor.uid, resolvedByName: actor.name });
        logActionInTransaction(tx, { ...auditActor(actor), action: 'report_resolved', targetType: 'report', targetId: record.id, details: { status: 'Resolved' } });
      }
      tx.update(db.doc('reports/' + record.id), updates);
      if (mirrors[index]?.exists) {
        const { status, ...mirrorUpdates } = updates;
        tx.update(mirrors[index]!.ref, { ...mirrorUpdates, ...(status ? { reportStatus: status } : {}) });
      }
    });
    const incident = { reportIds: nextIds, reportCount: nextIds.length, type: reportType(anchor), barangayIds: [...new Set(records.filter(record => nextIds.includes(record.id)).map(record => record.barangayId))],
      status: operation === 'resolve' ? 'Resolved' : operation === 'ungroup' ? 'Ungrouped' : 'Verified', updatedAt: now, updatedBy: actor.uid,
      ...(operation === 'resolve' ? { resolvedAt: now, resolvedBy: actor.uid } : {}),
      ...(!previous ? { createdAt: now, createdBy: actor.uid } : {}) };
    tx.set(incidentRef, incident, { merge: true });
    logActionInTransaction(tx, { ...auditActor(actor), action: operation === 'group' ? previous ? 'incident_updated' : 'reports_grouped' : operation === 'ungroup' ? 'reports_ungrouped' : 'incident_resolved', targetType: 'report', targetId: anchorId,
      details: { incidentId: incidentRef.id, reportIds: nextIds, before: { reportIds: previousIds }, count: nextIds.length } });
    return { id: incidentRef.id, ...previous, ...incident };
  });
  invalidateReportReads();
  return result;
}
