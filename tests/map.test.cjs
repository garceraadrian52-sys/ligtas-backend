const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');
const queries = [];
let role = 'BARANGAY_OFFICIAL';
const collections = {
  reports: [{id:'flood-1',type:'flood',location:'Wawa',reporterId:'private-user'}, {id:'road-1',type:'road'}],
  roadConditions: [], evacuationCenters: [],
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = {exports:{db:{collection(name) {
  const query = {where(field, op, value) {queries.push({name,field,value}); return query;}, async get() {return {docs:collections[name].map(item=>({id:item.id,data:()=>item}))};}};
  return query;
}}}};
require.cache[require.resolve('../dist/middleware/auth')] = {exports:{requireAuth(req,res,next){req.user={role,barangayId:'wawa'};next();}, requireOfficial(req,res,next){next();}}};
const app=express();app.use(express.json());app.use('/map',require('../dist/routes/map').default);
app.use('/evacuation-centers',require('../dist/routes/evacuationCenters').default);
let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}`;});
after(()=>{server.closeAllConnections();server.close();});
test('map scopes every collection to the official barangay and omits reporter identity',async()=>{
  const response=await fetch(base+'/map/monitoring'); const {data}=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(queries.map(q=>q.name).sort(),['evacuationCenters','reports','roadConditions']);
  assert.ok(queries.every(q=>q.field==='barangayId'&&q.value==='wawa'));
  assert.equal(data.floodReports.length,1);
  assert.equal(data.floodReports[0].reporterId,undefined);
});
test('LGU map reads all barangays',async()=>{
  role='LGU_ADMIN';queries.length=0;
  const response=await fetch(base+'/map/monitoring');
  assert.equal(response.status,200);assert.equal(queries.length,0);
});
test('center registration rejects incomplete coordinates and invalid occupancy before any write',async()=>{
  role='LGU_ADMIN';
  for (const invalid of [{latitude:14.8}, {latitude:91,longitude:120}, {occupied:101}, {capacity:1.5}, {capacity:true}, {capacity:[100]}, {occupied:null}, {name:"   "}, {address:{}}]) {
    const response=await fetch(base+'/evacuation-centers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test',barangayId:'wawa',capacity:100,...invalid})});
    assert.equal(response.status,400);
  }
});

test('resolved floods and road mirrors are omitted from monitoring without deleting their source records', async () => {
 collections.reports.push({id:'resolved-flood',type:'flood',status:'Resolved',verification:'Verified'});
 collections.roadConditions.push({id:'resolved-road',status:'Not Passable',verification:'Verified',reportStatus:'Resolved'});
 require('../dist/services/reportReads').invalidateReportReads();
 const response=await fetch(base+'/map/monitoring');
 const {data}=await response.json();
 assert.ok(!data.floodReports.some(item=>item.id==='resolved-flood'));
 assert.ok(!data.roadConditions.some(item=>item.id==='resolved-road'));
 assert.ok(collections.reports.some(item=>item.id==='resolved-flood'));
});

test('map exposes incident support counts while preserving report coordinates and critical pending records',async()=>{
 collections.reports.push({id:'incident-report',type:'flood',status:'Verified',verification:'Verified',latitude:14.81,longitude:120.91,incidentId:'group',incidentReportCount:2,incidentReportIds:['incident-report','support']},{id:'urgent-pending',type:'flood',status:'Pending',priority:'Critical'});require('../dist/services/reportReads').invalidateReportReads();
 const {data}=await (await fetch(base+'/map/monitoring')).json();const grouped=data.floodReports.find(item=>item.id==='incident-report');assert.equal(grouped.incidentReportCount,2);assert.equal(grouped.latitude,14.81);assert.equal(data.floodReports.find(item=>item.id==='urgent-pending').priority,'Critical');
});

test('an opt-in monitoring bundle reuses the scoped reports already read by the map',async()=>{
 role='BARANGAY_OFFICIAL';queries.length=0;
 require('../dist/services/reportReads').invalidateReportReads();
 const {data}=await (await fetch(base+'/map/monitoring?includeReports=1')).json();
 assert.ok(Array.isArray(data.reports));
 assert.ok(data.reports.some(item=>item.id==='urgent-pending'));
 assert.equal(queries.filter(item=>item.name==='reports').length,1);
 assert.ok(queries.every(item=>item.value==='wawa'));
 assert.equal((await (await fetch(base+'/map/monitoring')).json()).data.reports,undefined);
});
