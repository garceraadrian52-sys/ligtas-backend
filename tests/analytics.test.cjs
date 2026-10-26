const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeReportAnalytics: summarize, recordedMillis, validAnalyticsMonth } = require('../dist/services/reportAnalytics');
const now = Date.parse('2026-11-02T00:00:00Z');
const report = (data = {}) => ({ type: 'flood', status: 'Pending', barangayId: 'wawa', ...data });
const sample = [
  report({ createdAt: '2026-09-30T15:59:59Z' }),
  report({ createdAt: '2026-09-30T16:00:00Z', type: 'Flooding', status: 'approved', priority: 'High', verifiedAt: '2026-09-30T17:00:00Z' }),
  report({ createdAt: '2026-10-06T01:00:00Z', type: 'road', roadName: 'Market road', matchedRoadId: 'market', status: 'Resolved', verification: 'Verified', priority: 'Critical', verifiedAt: '2026-10-06T02:00:00Z', reviewedAt: '2026-10-06T05:00:00Z', resolvedAt: '2026-10-06T05:00:00Z' }),
  report({ createdAt: '2026-10-06T01:30:00Z', type: 'Road Condition', roadName: 'MARKET ROAD', matchedRoadId: 'market', status: 'denied', priority: 'Low', reviewedAt: '2026-10-06T02:00:00Z' }),
  report({ createdAt: '2026-10-31T15:59:59Z', barangayId: null, verification: 'Verified' }),
  report({ createdAt: '2026-10-31T16:00:00Z' }),
  report({ status: 'unexpected', type: 'unexpected', createdAt: 'not a date' }),
];

test('month cohorts, rankings, timing and status totals agree using Manila boundaries', () => {
  const data = summarize(sample, { month: '2026-10', now, barangays: [{ id: 'wawa', name: 'Wawa' }] });
  assert.equal(data.total, 4);
  assert.deepEqual(data.byStatus, { Pending: 1, Verified: 1, Rejected: 1, Resolved: 1, Other: 0 });
  assert.equal(data.approved, 2); assert.equal(data.approvalRate, 50);
  assert.equal(data.barangays[0].name, 'Wawa'); assert.equal(data.barangays[0].count, 3);
  assert.equal(data.roads.length, 1); assert.equal(data.roads[0].count, 2);
  assert.equal(data.hourly[0].count, 1); assert.equal(data.hourly[9].count, 2); assert.equal(data.hourly[23].count, 1);
  assert.equal(data.peakHours.overall.hour, 9);
  assert.equal(data.verification.averageMinutes, 50); assert.equal(data.verification.count, 3);
  assert.equal(data.resolution.averageMinutes, 180); assert.equal(data.resolution.count, 1);
  assert.equal(data.monthly.at(-1).total, 4); assert.equal(data.monthly.at(-1).Resolved, 1);
  assert.equal(data.comparison.previousTotal, 1); assert.equal(data.comparison.changePercent, 300);
  assert.equal(data.coverage.undatedReports, 1);
  assert.equal(data.period.startAt, '2026-09-30T16:00:00.000Z');
  assert.equal(data.period.endAt, '2026-10-31T16:00:00.000Z');
});

test('all time includes undated/unknown reports once without inventing a submission date', () => {
  const data = summarize(sample, { now });
  assert.equal(data.total, 7); assert.equal(data.byStatus.Other, 1); assert.equal(data.byType.other, 1);
  assert.equal(Object.values(data.byStatus).reduce((a, b) => a + b, 0), data.total);
  assert.equal(data.hourly.reduce((a, b) => a + b.count, 0), 6);
  assert.equal(data.barangays.reduce((a, b) => a + b.count, 0), 7);
  assert.equal(data.period.month, null); assert.equal(data.comparison.changePercent, null);
});

test('missing, backward and future intervals are excluded; updatedAt is never used', () => {
  const data = summarize([
    report({ status: 'Resolved', createdAt: '2026-10-01', reviewedAt: '2026-10-02', resolvedAt: '2026-10-02' }),
    report({ status: 'Verified', createdAt: '2026-10-02', verifiedAt: '2026-10-01', updatedAt: '2026-10-03' }),
    report({ status: 'Verified', createdAt: '2026-10-01', verifiedAt: '2027-01-01' }),
  ], { now });
  assert.equal(data.verification.averageMinutes, null); assert.equal(data.verification.eligibleCount, 3);
  assert.equal(data.resolution.averageMinutes, null); assert.equal(data.resolution.count, 0);
  const resolved = summarize([report({ status: 'Resolved', createdAt: '2026-10-01T00:00Z', reviewedAt: '2026-10-01T01:00Z', resolvedAt: '2026-10-01T03:00Z' })], { now });
  assert.equal(resolved.verification.averageMinutes, 60); assert.equal(resolved.resolution.averageMinutes, 120);
});

test('zero-minute official verification is a real measurement; empty analytics are not samples', () => {
  const data = summarize([report({ status: 'Verified', createdAt: '2026-10-01', verifiedAt: '2026-10-01' })], { now });
  assert.equal(data.verification.averageMinutes, 0); assert.equal(data.verification.count, 1);
  assert.equal(data.verification.bySeverity[0].label, 'Not recorded');
  const empty = summarize([], { now, month: '2026-01' });
  assert.equal(empty.total, 0); assert.equal(empty.approvalRate, null);
  assert.equal(empty.peakHours.overall, null); assert.equal(empty.verification.averageMinutes, null);
  assert.equal(empty.monthly.length, 6); assert.equal(empty.monthly[0].month, '2025-08');
  assert.ok(empty.hourly.every(bin => bin.count === 0));
  assert.equal(empty.comparison.changePercent, null);
});

test('date decoding accepts Firestore, Date, ISO and epoch milliseconds, rejects invalid values', () => {
  const expected = Date.parse('2026-10-01T00:00:00Z');
  for (const input of [{ toMillis: () => expected }, { seconds: expected / 1000 }, { _seconds: expected / 1000 }, new Date(expected), expected, '2026-10-01T00:00:00Z']) assert.equal(recordedMillis(input), expected);
  for (const input of [null, true, false, '', {}, [], 'invalid', Infinity, { seconds: 'bad' }, { toMillis: () => NaN }]) assert.equal(recordedMillis(input), null);
  assert.equal(recordedMillis(0), 0);
  for (const input of ['', '2026-00', '2026-13', ['2026-10'], '2026-1', '2026-10/anything']) assert.equal(validAnalyticsMonth(input), false);
});

test('road ranking separates same-named roads in different barangays and avoids unsafe group keys', () => {
  const data = summarize([
    report({ type: 'road', roadName: 'Main road', barangayId: '__proto__' }),
    report({ type: 'road', roadName: 'Main road', barangayId: 'other' }),
    report({ type: 'road', barangayId: 'other' }),
  ], { now });
  assert.equal(data.roads.length, 2); assert.equal(data.coverage.unnamedRoadReports, 1);
  assert.equal(data.byBarangay.__proto__, 1);
});
