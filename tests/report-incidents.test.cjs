const { test } = require('node:test');
const assert = require('node:assert/strict');
let documents = new Map(), sequence = 0, queue = Promise.resolve();
const ref = path => ({ path, id: path.split('/').at(-1), get: async () => snap(path) });
const snap = path => ({ exists: documents.has(path), id: path.split('/').at(-1), ref: ref(path), data: () => documents.get(path) });
const db = {
  doc: ref, collection: collection => ({ doc: id => ref(collection + '/' + (id || 'generated-' + ++sequence)) }),
  runTransaction(callback) {
    const execute = async () => {
      const writes = [];
      let writing = false;
      const value = await callback({
        get: async reference => { assert.equal(writing, false, 'all transaction reads must precede writes'); return snap(reference.path); },
        update(reference, data) { writing = true; writes.push(() => documents.set(reference.path, { ...documents.get(reference.path), ...data })); },
        set(reference, data) { writing = true; writes.push(() => documents.set(reference.path, { ...documents.get(reference.path), ...data })); },
        create(reference, data) { writing = true; writes.push(() => documents.set(reference.path, data)); },
      });
      writes.forEach(write => write()); return value;
    };
    const result = queue.then(execute); queue = result.catch(() => {}); return result;
  },
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
const { changeReportIncident, suggestRelatedReports, relatedReportDistance } = require('../dist/services/reportIncidents');
const bo = { uid: 'bo', name: 'Assigned Official', role: 'BARANGAY_OFFICIAL', barangayId: 'wawa' };
const admin = { ...bo, uid: 'admin', role: 'LGU_ADMIN', barangayId: null };
const base = { type: 'flood', status: 'Pending', verification: 'Pending', priority: 'Critical', barangayId: 'wawa', latitude: 14.81, longitude: 120.91, createdAt: new Date('2026-11-21T01:00:00Z'), photoUrl: 'https://example.org/evidence.jpg', description: 'Original evidence description' };
const reset = (extra = {}) => { documents = new Map(['a', 'b', 'c'].map(id => ['reports/' + id, { ...base, ...extra }])); };
const audit = action => [...documents.values()].filter(record => record.action === action);

test('suggestions require type, distance and actual submission time and preserve critical pending reports', () => {
  const a = { ...base, id: 'a' };
  const candidates = [{ ...base, id: 'b' }, { ...base, id: 'road', type: 'road' }, { ...base, id: 'far', latitude: 14.9 }, { ...base, id: 'old', createdAt: new Date('2026-11-20') }, { ...base, id: 'no-time', createdAt: null }, { ...base, id: 'foreign', barangayId: 'santol' }, { ...base, id: 'member', incidentId: 'other' }, { ...base, id: 'rejected', status: 'Rejected' }];
  assert.deepEqual(suggestRelatedReports(a, candidates, bo).map(item => item.id), ['b']);
  assert.deepEqual(suggestRelatedReports(a, candidates, admin).map(item => item.id), ['b', 'foreign']);
  assert.equal(a.status, 'Pending'); assert.equal(a.priority, 'Critical');
  assert.equal(relatedReportDistance(a, { ...base, createdAt: new Date(base.createdAt.getTime() + 6 * 3600000) }), 0);
  assert.equal(relatedReportDistance(a, { ...base, createdAt: new Date(base.createdAt.getTime() + 6 * 3600000 + 1) }), null);
});
test('BO verification/grouping atomically preserves originals, evidence, mirrors and records audits once', async () => {
  reset(); documents.set('reports/b', { ...base, roadConditionId: 'b' }); documents.set('roadConditions/b', { status: 'LIMITED', reportStatus: 'Pending' });
  const result = await changeReportIncident(bo, 'a', { reportIds: ['a', 'b'] });
  for (const id of ['a', 'b']) {
    const report = documents.get('reports/' + id);
    assert.equal(report.status, 'Verified'); assert.equal(report.verification, 'Verified');
    assert.equal(report.incidentId, result.id); assert.equal(report.incidentReportCount, 2);
    assert.equal(report.photoUrl, base.photoUrl); assert.equal(report.description, base.description); assert.equal(report.priority, 'Critical');
    assert.equal(report.verifiedBy, 'bo'); assert.ok(report.verifiedAt instanceof Date);
  }
  assert.equal(documents.get('roadConditions/b').status, 'LIMITED'); assert.equal(documents.get('roadConditions/b').reportStatus, 'Verified');
  assert.equal(audit('report_verified').length, 2); assert.equal(audit('reports_grouped').length, 1);
  const previousTime = documents.get('reports/a').verifiedAt;
  const retry = await changeReportIncident(bo, 'a', { reportIds: ['b', 'a'] });
  assert.equal(retry.id, result.id); assert.equal(audit('reports_grouped').length, 1); assert.equal(documents.get('reports/a').verifiedAt, previousTime);
});
test('BO scope, resident denial and invalid memberships roll back all writes', async () => {
  for (const actor of [{ ...bo, barangayId: null }, { ...bo, role: 'RESIDENT' }]) {
    reset(); await assert.rejects(changeReportIncident(actor, 'a', { reportIds: ['a', 'b'] }), { status: 403 });
    assert.equal(documents.get('reports/a').status, 'Pending');
  }
  reset(); documents.set('reports/b', { ...base, barangayId: 'santol' });
  await assert.rejects(changeReportIncident(bo, 'a', { reportIds: ['a', 'b'] }), { status: 403 });
  assert.equal(audit('report_verified').length, 0);
  await assert.rejects(changeReportIncident(admin, 'a', { reportIds: ['a', 'a'] }), { status: 400 });
  await assert.rejects(changeReportIncident(admin, 'a', { reportIds: ['b', 'c'] }), { status: 400 });
  documents.set('reports/b', { ...base, status: 'Rejected' });
  await assert.rejects(changeReportIncident(admin, 'a', { reportIds: ['a', 'b'] }), { status: 409 });
  assert.equal(documents.get('reports/a').status, 'Pending');
});
test('LGU can correct cross-barangay membership, ungroup and resolve with original verification dates', async () => {
  reset(); documents.set('reports/b', { ...base, barangayId: 'santol' });
  await changeReportIncident(admin, 'a', { reportIds: ['a', 'b'] });
  await assert.rejects(changeReportIncident(bo, 'a', { reportIds: ['a', 'b'] }), { status: 403 });
  await changeReportIncident(admin, 'a', { reportIds: ['a', 'c'] });
  assert.equal(documents.get('reports/b').incidentId, null); assert.equal(documents.get('reports/b').status, 'Verified');
  assert.equal(audit('incident_updated').length, 1);
  await assert.rejects(changeReportIncident(bo, 'a', { operation: 'ungroup' }), { status: 403 });
  await changeReportIncident(admin, 'a', { operation: 'ungroup' });
  assert.equal(documents.get('reports/a').incidentId, null); assert.equal(audit('reports_ungrouped').length, 1);
  const grouped = await changeReportIncident(admin, 'a', { reportIds: ['a', 'b'] });
  const verifiedAt = documents.get('reports/b').verifiedAt;
  await changeReportIncident(admin, 'a', { operation: 'resolve' });
  assert.equal(documents.get('reports/a').status, 'Resolved'); assert.equal(documents.get('reports/b').status, 'Resolved');
  assert.equal(documents.get('reports/c').status, 'Verified'); assert.equal(documents.get('reports/b').verifiedAt, verifiedAt);
  assert.equal(documents.get('incidents/' + grouped.id).status, 'Resolved'); assert.equal(audit('incident_resolved').length, 1);
  await changeReportIncident(admin, 'b', { operation: 'resolve' }); assert.equal(audit('incident_resolved').length, 1);
  await assert.rejects(changeReportIncident(admin, 'a', { reportIds: ['a', 'c'] }), { status: 409 });
});
test('competing group requests cannot assign a report to two incidents', async () => {
  reset();
  const results = await Promise.allSettled([changeReportIncident(admin, 'a', { reportIds: ['a', 'b'] }), changeReportIncident(admin, 'c', { reportIds: ['c', 'b'] })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(documents.get('reports/c').incidentId, undefined); assert.equal(audit('reports_grouped').length, 1);
});
