import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { normalizeRole } from './roles';
import { allocateDisplayId } from './recordDisplayIds';
import { resolveReportBarangay, ReportLocationError } from './reportBarangay';
import { isInBalagtas } from './balagtasMonitoring';

export class ReportSubmissionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function text(value: unknown, label: string, limit: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > limit) throw new ReportSubmissionError('Enter ' + label + ' (up to ' + limit + ' characters).');
  return value.trim();
}
export async function submitLocatedReport(db: Firestore, uid: string, input: any) {
  const id = text(input?.id, 'a report ID', 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ReportSubmissionError('Invalid report ID.');
  if (input.ownerId != null && input.ownerId !== uid) throw new ReportSubmissionError('Sign in to the account that saved this report.', 403);
  if (!['flood', 'road'].includes(input.type)) throw new ReportSubmissionError('Choose a flooding or road report.');
  const location = text(input.location, 'the report location', 500), description = text(input.description, 'a description', 5000);
  let area;
  try { area = resolveReportBarangay(input.latitude, input.longitude); }
  catch (error) { if (error instanceof ReportLocationError) throw new ReportSubmissionError(error.message); throw error; }
  if (input.photoUrl != null && (typeof input.photoUrl !== 'string' || input.photoUrl.length > 2500 || !/^https:\/\//i.test(input.photoUrl))) throw new ReportSubmissionError('Invalid report photo.');
  const details: Record<string, any> = {};
  for (const field of input.type === 'road' ? ['roadStatus', 'floodingLevel', 'cause', 'roadName', 'matchedRoadId', 'matchSource'] : ['waterLevel']) {
    if (input[field] != null) details[field] = text(input[field], field, 500);
  }
  for (const field of ['affectedStart', 'affectedEnd']) {
    if (input[field] != null) {
      if (!isInBalagtas(input[field])) throw new ReportSubmissionError('Road endpoints must be inside Balagtas.');
      details[field] = { latitude: input[field].latitude, longitude: input[field].longitude };
    }
  }
  if (input.path != null) {
    if (!Array.isArray(input.path) || input.path.length < 2 || input.path.length > 2000 || input.path.some((p: any) => !p || !isInBalagtas(p))) throw new ReportSubmissionError('Invalid affected road path.');
    details.path = input.path.map((p: any) => ({ latitude: p.latitude, longitude: p.longitude }));
  }
  return db.runTransaction(async tx => {
    const profile = (await tx.get(db.doc('users/' + uid))).data();
    const role = normalizeRole(profile?.role);
    if (!profile || profile.disabled === true || !['RESIDENT', 'BARANGAY_OFFICIAL', 'LGU_ADMIN'].includes(role)) throw new ReportSubmissionError('An active resident or official account is required.', 403);
    const ref = db.doc('reports/' + id), existing = await tx.get(ref);
    if (existing.exists) {
      if (existing.get('reporterId') !== uid) throw new ReportSubmissionError('This report ID is already in use.', 409);
      return { id, barangayId: existing.get('barangayId'), status: existing.get('status'), duplicate: true };
    }
    const areaDoc = await tx.get(db.doc('barangays/' + area.id));
    if (!areaDoc.exists) throw new ReportSubmissionError('The report barangay is unavailable. Contact your administrator.', 503);
    const displayId = await allocateDisplayId(tx, db, 'reports');
    const verified = input.official === true && (role === 'LGU_ADMIN' || (role === 'BARANGAY_OFFICIAL' && profile.barangayId === area.id));
    const status = verified ? 'Verified' : 'Pending';
    const now = FieldValue.serverTimestamp();
    const common = {
      location, description, latitude: input.latitude, longitude: input.longitude,
      reporterId: uid, reporterName: String(profile.name ?? profile.displayName ?? 'Resident'),
      barangayId: area.id, barangayName: area.name, routingVersion: 1, routingSource: 'incident_coordinates', boundarySource: area.boundarySource,
      photoUrl: input.photoUrl ?? null, status, verification: status, submittedByOfficial: verified, createdByRole: role,
      priority: ['Normal', 'High', 'Critical'].includes(input.priority) ? input.priority : 'Normal',
      submittedAt: typeof input.submittedAt === 'string' ? input.submittedAt.slice(0, 40) : null, createdAt: now, updatedAt: now,
      ...(verified ? { verifiedBy: uid, verifiedByName: String(profile.name ?? profile.displayName ?? 'Official'), verifiedAt: now } : {}),
    };
    tx.create(ref, { ...common, ...details, displayId, type: input.type, reportType: input.type, ...(input.type === 'road' ? { roadConditionId: id } : {}) });
    if (input.type === 'road') tx.create(db.doc('roadConditions/' + id), {
      ...common, ...details, roadConditionId: id, name: details.roadName ?? location, reason: details.cause ?? '',
      status: details.roadStatus ?? 'Not specified', reportStatus: status, source: verified ? 'official_report' : 'resident_report',
    });
    return { id, displayId, barangayId: area.id, barangayName: area.name, status, duplicate: false };
  });
}
