const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
let role = 'LGU_ADMIN', barangayId = 'wawa', fail = false, failActive = false;
const queries = [];
const records = {
  reports: [{ type: 'road', barangayId: 'wawa', createdAt: '2026-10-01' }, { type: 'flood', barangayId: 'san-juan', createdAt: '2026-10-02' }],
  evacuationCenters: [{id:'wc',barangayId:'wawa',name:'Wawa center',occupied:3,capacity:10},{id:'sc',barangayId:'san-juan',name:'San Juan center',occupied:1,capacity:4}],
  activeEvacuations: [{id:'wh',householdId:'wh',barangayId:'wawa',memberIds:['a','b','c']},{id:'sh',householdId:'sh',barangayId:'san-juan',memberIds:['d']}],
  barangays: [{ id: 'wawa', name: 'Wawa' }, { id: 'san-juan', name: 'San Juan' }],
};
const db = {
  doc: () => ({ get: async () => ({ data: () => ({ role, barangayId }) }) }),
  collection(name) {
    let scoped = records[name];
    return { where(field, op, value) { queries.push({ name, field, value }); scoped = scoped.filter(item => item[field] === value); return this; },
      async get() { if (fail || (failActive && name === 'activeEvacuations')) throw new Error('offline'); return { docs: scoped.map((item, i) => ({ id: item.id || String(i), data: () => item })) }; } };
  },
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth: { verifyIdToken: async () => ({ uid: 'tester' }) } } };
const app = express(); app.use('/analytics', require('../dist/routes/analytics').default);
let server, base;
before(async () => { server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); base = `http://127.0.0.1:${server.address().port}/analytics/reports`; });
after(() => { server.closeAllConnections(); server.close(); });
const get = (suffix = '', auth = true) => fetch(base + suffix, { headers: auth ? { Authorization: 'Bearer test' } : {} });

test('analytics enforces sign-in and official role before reading data', async () => {
  assert.equal((await get('', false)).status, 401);
  role = 'RESIDENT'; assert.equal((await get()).status, 403);
  role = 'BARANGAY_OFFICIAL'; barangayId = null; assert.equal((await get()).status, 403);
});
test('official analytics include only the assigned barangay; LGU and Super Admin include all', async () => {
  role = 'BARANGAY_OFFICIAL'; barangayId = 'wawa'; queries.length = 0;
  const response = await get('?month=2026-10'); const { data } = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(data.total, 1); assert.equal(data.scope.label, 'Wawa');
  assert.equal(data.presentation.scopeLabel, 'Wawa'); assert.equal(data.presentation.metrics[0][2], '1');
  assert.deepEqual(queries, ['reports','evacuationCenters','activeEvacuations'].map(name=>({name,field:'barangayId',value:'wawa'})));
  assert.equal(data.overview.evacuation.totalEvacuees,3); assert.equal(data.overview.total,0);
  role = 'LGU_ADMIN'; queries.length = 0;
  const admin = await (await get()).json(); assert.equal(admin.data.total, 2); assert.equal(queries.length, 0);
  role = 'SUPER_ADMIN'; queries.length = 0;
  const superAdmin = await (await get()).json(); assert.equal(superAdmin.data.total, 2); assert.equal(queries.length, 0);
});
test('bad month filters are rejected and database errors are never successful zero counts', async () => {
  role = 'LGU_ADMIN';
  for (const suffix of ['?month=2026-13', '?month=2026-10&month=2026-11', '?month=']) assert.equal((await get(suffix)).status, 400);
  fail = true; const response = await get(); assert.equal(response.status, 500); assert.equal((await response.json()).data, undefined); fail = false;
});

test('evacuation failures remain unavailable without suppressing authorized flood analytics',async()=>{
 role='LGU_ADMIN';failActive=true;const response=await get();const {data}=await response.json();assert.equal(response.status,200);assert.equal(data.overview.total,1);assert.equal(data.overview.evacuation.activeAvailable,false);assert.equal(data.overview.evacuation.totalEvacuees,null);assert.equal(data.overview.evacuation.centersAvailable,true);failActive=false;
});

test('global filters update summaries, rankings, exports and trends together',async()=>{
 role='LGU_ADMIN';const {data}=await(await get('?reportType=road&barangayId=wawa&start=2026-10-01&end=2026-10-01')).json();assert.equal(data.total,1);assert.equal(data.overview.total,1);assert.equal(data.overview.metrics[0][1],'Total Road Reports');assert.equal(data.overview.metrics[3][1],'Confirmed Incidents');assert.equal(data.overview.trend.reduce((sum,row)=>sum+row.total,0),1);assert.equal(data.overview.incidents.individualReports,1);assert.ok(data.overview.csvRows.some(row=>row[0]==='Report type'&&row[1]==='road'));
 for(const query of ['?start=2026-02-30','?start=2026-11-22&end=2026-11-21','?reportType=invalid'])assert.equal((await get(query)).status,400);
 role='BARANGAY_OFFICIAL';barangayId='wawa';assert.equal((await get('?barangayId=san-juan')).status,403);
});
test('moved evacuation analytics respect role scope and retain current occupancy calculations',async()=>{
 role='BARANGAY_OFFICIAL';barangayId='wawa';const response=await fetch(base.replace('/reports','/evacuation'),{headers:{Authorization:'Bearer test'}});const {data}=await response.json();assert.equal(data.totalEvacuees,3);assert.equal(data.utilization.length,1);assert.equal(data.utilization[0].occupied,3);
});
