const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeReportAnalytics: summarize } = require('../dist/services/reportAnalytics');
const { presentReportAnalytics: present, durationLabel } = require('../dist/services/reportAnalyticsPresentation');
const now = Date.parse('2026-10-26T00:00:00Z');
const records = [
  { status:'Verified', type:'flood', barangayId:'wawa', priority:'High', createdAt:'2026-10-25T01:00:00Z', verifiedAt:'2026-10-25T01:30:00Z' },
  { status:'Resolved', type:'road', roadName:'Market Road', barangayId:'wawa', priority:'Critical', createdAt:'2026-10-25T01:00:00Z', verifiedAt:'2026-10-25T02:00:00Z', resolvedAt:'2026-10-25T05:00:00Z' },
  { status:'Pending', type:'road', roadName:'Market Road', barangayId:'wawa', createdAt:'2026-10-25T03:00:00Z' },
];
test('the original dashboard receives calculated tuples, chart paths and matching CSV values', () => {
  const summary = summarize(records, {now, barangays:[{id:'wawa',name:'Wawa'}]});
  const view = present(summary,'Balagtas, Bulacan');
  assert.equal(view.metrics.length,5); assert.equal(view.metrics[0][2],'3');
  assert.equal(view.metrics[1][2],'45m'); assert.equal(view.metrics[2][2],'3h');
  assert.equal(view.metrics[3][2],'9:00 AM'); assert.equal(view.metrics[4][2],'66.7%');
  assert.deepEqual(view.barangays,[['Wawa',3]]); assert.deepEqual(view.roads,[['Market Road','Wawa',2]]);
  assert.equal(view.statusLegend[0].count,2); assert.equal(view.statusLegend[1].count,1);
  assert.ok(view.charts.peak.line.startsWith('M30 148')); assert.ok(view.charts.peak.description.includes('9:00 AM: 2'));
  assert.equal(view.charts.trend.labels.length,6);
  assert.ok(view.csvRows.some(row=>row[0]==='Total reports'&&row[1]===3));
  assert.ok(view.csvRows.some(row=>row[0]==='Average resolution time (minutes)'&&row[1]===180));
  assert.equal(view.resolution.find(row=>row[0]==='Evacuation')[1],'Not recorded');
  assert.equal(view.resolution.find(row=>row[0]==='Alert History')[1],'Not recorded');
  assert.ok(!JSON.stringify(view).includes('NaN'));
});
test('empty data keeps the original panel shapes without sample counts or durations', () => {
  const view=present(summarize([],{now}),'Balagtas, Bulacan');
  assert.equal(view.metrics[0][2],'0'); assert.equal(view.metrics[1][2],'Not recorded');
  assert.equal(view.metrics[4][2],'Not recorded'); assert.equal(view.statusGradient,'#e8edf4');
  assert.equal(view.verification.length,4); assert.equal(view.resolution.length,4);
  assert.ok([...view.verification,...view.resolution].every(row=>row[1]==='Not recorded'&&row[2]===0));
  assert.ok(!/NaN|Infinity/.test(view.charts.peak.line+view.charts.trend.total));
  assert.equal(view.peaks.quiet,'Not recorded');
});
test('zero durations remain zero, and unknown statuses stay visible instead of being relabeled', () => {
  assert.equal(durationLabel(0),'0m'); assert.equal(durationLabel(null),'Not recorded');
  const summary=summarize([{status:'unexpected',type:'flood',createdAt:'2026-10-25'}],{now});
  const view=present(summary,'Test scope');
  assert.equal(view.statusLegend.find(row=>row.key==='other').count,1);
  assert.equal(view.statusLegend[1].count,0); assert.equal(view.statusDescription.includes('1 Other / unrecorded'),true);
});
