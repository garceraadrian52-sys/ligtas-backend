const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDashboard } = require('../dist/services/dashboardSummary');
test('dashboard excludes expired alerts, sorts recent advisories and uses Manila dates', () => {
 const now=Date.parse('2026-09-30T01:00:00Z');
 const result=summarizeDashboard([{status:'pending'}, {status:'Verified',verifiedAt:'2026-09-29T17:00:00Z'}], [{id:'old',status:'active',expiresAt:'2026-09-29'}, {id:'draft',status:'draft'}, {id:'a',status:'published',createdAt:'2026-09-29'}, {id:'b',status:'Active',createdAt:'2026-09-30'}], [{id:'c',name:'Center',occupied:3,capacity:10},{occupied:-1,capacity:'invalid'}],now);
 assert.equal(result.pendingReports,1);assert.equal(result.verifiedToday,1);assert.equal(result.activeAlerts,2);
 assert.deepEqual(result.recentAlerts.map(a=>a.id),['b','a']);assert.equal(result.evacuationCenters.totalOccupied,3);assert.equal(result.evacuationCenters.totalCapacity,10);
});
