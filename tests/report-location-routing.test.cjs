const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveReportBarangay } = require('../dist/services/reportBarangay');
const { submitLocatedReport } = require('../dist/services/reportSubmission');
const { reportStore } = require('./helpers/reportStore.cjs');
const input = (extra = {}) => ({ id: 'outbox-job', ownerId: 'reporter', type: 'flood', location: 'Incident in Wawa', description: 'Water on road', latitude: 14.81329798, longitude: 120.90529689, waterLevel: 'Knee Deep', ...extra });

test('coordinates resolve all nine barangays without using the resident address or location text', () => {
  const pins = [ ['borol_1st',14.82582422,120.90624966], ['borol_2nd',14.82915684,120.90216332], ['dalig',14.83122956,120.92307397], ['longos',14.820469,120.91198475], ['panginay',14.79272494,120.89851665], ['pulong_gubat',14.85776108,120.90483078], ['san_juan',14.78834671,120.90332695], ['santol',14.84771334,120.91231394], ['wawa',14.81329798,120.90529689] ];
  assert.throws(() => resolveReportBarangay(14.8330727, 120.9050248), /unambiguously/);
  for (const [area, lat, lon] of pins) assert.equal(resolveReportBarangay(lat, lon).id, 'barangay_' + area);
  for (const [lat, lon] of [[null,null], [NaN,120.9], ['14.8',120.9], [14.6,120.9], [14.8,121.9]]) assert.throws(() => resolveReportBarangay(lat,lon));
});
test('resident from Borol 1st reports in Wawa and cannot forge routing or verification metadata', async () => {
  const { db, records } = reportStore();
  const result = await submitLocatedReport(db, 'reporter', input({ barangayId: 'barangay_borol_1st', barangayName: 'Wrong', verification: 'Verified', verifiedBy: 'boWawa', reporterId: 'another', official: true, location: 'Panginay text cannot redirect this pin' }));
  assert.equal(result.barangayId, 'barangay_wawa'); assert.equal(result.status, 'Pending');
  const report = records.get('reports/outbox-job');
  assert.equal(report.reporterId, 'reporter'); assert.equal(report.reporterName, 'reporter'); assert.equal(report.verifiedBy, undefined); assert.equal(report.waterLevel, 'Knee Deep');
  assert.equal(records.get('users/reporter').barangayId, 'barangay_borol_1st'); assert.equal(report.displayId, 'RP-00001');
});
test('road report and mirror share the incident area and retries do not duplicate either record', async () => {
  const { db, records } = reportStore();
  const body = input({ type: 'road', roadStatus: 'Passable', floodingLevel: 'Gutter Level', cause: 'Flooding' });
  const results = await Promise.all([submitLocatedReport(db, 'reporter', body), submitLocatedReport(db, 'reporter', body)]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  assert.equal(records.get('reports/outbox-job').barangayId, 'barangay_wawa');
  const mirror = records.get('roadConditions/outbox-job'); assert.equal(mirror.barangayId, 'barangay_wawa'); assert.equal(mirror.reportStatus, 'Pending');
  assert.equal(records.get('recordIdCounters/reports').lastIssued, 1);
  await assert.rejects(submitLocatedReport(db, 'boWawa', { ...body, ownerId: 'boWawa' }), e => e.status === 409);
});
test('BO submissions are auto-verified only within their assigned incident barangay', async () => {
  const { db, records } = reportStore();
  const own = await submitLocatedReport(db, 'boWawa', input({ id: 'own', ownerId: 'boWawa', official: true }));
  assert.equal(own.status, 'Verified'); assert.equal(records.get('reports/own').verifiedBy, 'boWawa');
  const other = await submitLocatedReport(db, 'boBorol', input({ id: 'other', ownerId: 'boBorol', official: true }));
  assert.equal(other.status, 'Pending'); assert.equal(other.barangayId, 'barangay_wawa'); assert.equal(records.get('reports/other').verifiedBy, undefined);
});
test('invalid points, photo URLs, paths, owner IDs and disabled accounts cannot submit reports', async () => {
  const { db, records } = reportStore();
  for (const change of [{latitude:null}, {latitude:14.6}, {ownerId:'someone'}, {photoUrl:'file:///private'}, {path:[{latitude:0,longitude:0}]}, {id:'a/b'}, {description:''}]) await assert.rejects(submitLocatedReport(db,'reporter',input(change)));
  records.get('users/reporter').disabled = true;
  await assert.rejects(submitLocatedReport(db,'reporter',input()), e=>e.status===403);
  assert.equal(records.has('reports/outbox-job'), false);
});

test('pending rerouting is dry-run by default, preserves fields and mirrors, and leaves verified history alone', async () => {
  const { reroutePendingReport } = require('../dist/services/reportRerouting');
  const { db, records } = reportStore();
  const old = { reporterId: 'reporter', status: 'Pending', verification: 'Pending', barangayId: 'barangay_borol_1st', latitude: 14.81329798, longitude: 120.90529689, roadConditionId: 'old', description: 'Keep', createdAt: 'original-time' };
  records.set('reports/old', { ...old }); records.set('roadConditions/old', { ...old, reportStatus: 'Pending' });
  assert.equal((await reroutePendingReport(db, 'old')).status, 'would-update'); assert.equal(records.get('reports/old').barangayId, 'barangay_borol_1st');
  assert.equal((await reroutePendingReport(db, 'old', true)).status, 'updated');
  assert.equal(records.get('reports/old').barangayId, 'barangay_wawa'); assert.equal(records.get('roadConditions/old').barangayId, 'barangay_wawa'); assert.equal(records.get('reports/old').description, 'Keep'); assert.equal(records.get('reports/old').createdAt, 'original-time');
  assert.equal((await reroutePendingReport(db, 'old', true)).status, 'unchanged');
  records.set('reports/verified', { ...old, status: 'Verified', verification: 'Verified' });
  assert.equal((await reroutePendingReport(db, 'verified', true)).status, 'skipped'); assert.equal(records.get('reports/verified').barangayId, 'barangay_borol_1st');
});
