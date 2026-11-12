const { test } = require('node:test');
const assert = require('node:assert/strict');
const { summarizeDashboard } = require('../dist/services/dashboardSummary');
test('dashboard excludes expired alerts, sorts recent advisories and uses Manila dates', () => {
 const now=Date.parse('2026-09-30T01:00:00Z');
 const result=summarizeDashboard([{status:'pending'}, {status:'Verified',verifiedAt:'2026-09-29T17:00:00Z'}], [{id:'old',status:'active',expiresAt:'2026-09-29'}, {id:'draft',status:'draft'}, {id:'a',status:'published',createdAt:'2026-09-29'}, {id:'b',status:'Active',createdAt:'2026-09-30'}], [{id:'c',name:'Center',occupied:3,capacity:10},{occupied:-1,capacity:'invalid'}],now);
 assert.equal(result.pendingReports,1);assert.equal(result.verifiedToday,1);assert.equal(result.activeAlerts,2);
 assert.deepEqual(result.recentAlerts.map(a=>a.id),['b','a']);assert.equal(result.evacuationCenters.totalOccupied,3);assert.equal(result.evacuationCenters.totalCapacity,10);
});

test('dashboard returns the three newest unique active alerts with full detail fields',()=>{
 const now=Date.parse('2026-11-12T13:00:00Z');
 const newest={id:'new',title:'Newest advisory',status:'published',priority:'Normal',publishedAt:'2026-11-12T12:00:00Z',message:'Complete instructions.',category:'Flood Warning',locationScope:{type:'municipality'},recommendations:['Stay prepared.']};
 const alerts=[
  {id:'old-critical',status:'active',priority:'Critical',createdAt:'2026-11-10T00:00:00Z'},
  {id:'second',status:'monitoring',createdAt:'2026-11-12T11:00:00Z'},
  {id:'third',status:'published',createdAt:'2026-11-12T10:00:00Z'},
  newest,{...newest},{...newest,id:'duplicate-copy',publishedAt:'2026-11-12T11:59:00Z'},
  {id:'draft',status:'draft',createdAt:'2026-11-12T12:59:00Z'},
  {id:'expired',status:'published',createdAt:'2026-11-12T12:59:00Z',expiresAt:new Date(now).toISOString()},
  {id:'inactive',status:'published',isActive:false,createdAt:'2026-11-12T12:59:00Z'},
  {id:'disabled',status:'inactive',createdAt:'2026-11-12T12:59:00Z'},
 ];
 const result=summarizeDashboard([],alerts,[],now);
 assert.deepEqual(result.recentAlerts.map(item=>item.id),['new','second','third']);
 assert.equal(result.recentAlerts[0].message,newest.message);
 assert.equal(result.recentAlerts[0].type,'Flood Warning');
 assert.equal(result.recentAlerts[0].status,'published');
 assert.deepEqual(result.recentAlerts[0].locationScope,newest.locationScope);
 assert.deepEqual(result.recentAlerts[0].recommendations,newest.recommendations);
});
