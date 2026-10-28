const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.FIREBASE_PROJECT_ID = 'demo-ligtas-tests';
const { automaticReportAlert, automaticReportId, automaticWeatherAlert } = require('../dist/services/automaticAlertPolicy');
const { createAutomaticAlertEngine } = require('../dist/services/automaticAlerts');
const { published, inArea, kindForAlert, enabled } = require('../dist/services/notificationPolicy');
const { BALAGTAS_LOCATION } = require('../dist/services/balagtasMonitoring');
const now = Date.parse('2026-10-27T00:00:00Z');
const report = { type: 'flood', status: 'Verified', verification: 'Verified', barangayId: 'barangay_borol_1st', latitude: 14.8187, longitude: 120.9054,
  waterLevel: 'Waist Deep', location: 'Example street', description: 'Reported flooding', createdAt: new Date(now - 60000) };
const weather = { status: 'available', weatherCode: 95, condition: 'Thunderstorm', observedAt: new Date(now).toISOString(), location: BALAGTAS_LOCATION };

test('automatic flood alerts retain geographic scope and work with the real resident delivery policy', () => {
  const alert = { ...automaticReportAlert('r', report, now), status: 'active' };
  assert.equal(alert.priority, 'Critical');
  assert.equal(alert.category, 'Flood Warning');
  assert.deepEqual(alert.locationScope.barangayIds, ['barangay_borol_1st']);
  assert.equal(published(alert, now), true);
  assert.equal(inArea(alert, { role: 'RESIDENT', barangayId: 'borol_1st' }), true);
  assert.equal(inArea(alert, { role: 'RESIDENT', barangayId: 'barangay_wawa' }), false);
  assert.equal(kindForAlert(alert), 'alert');
  assert.equal(enabled({ notificationPreferences: { 'Flood Alerts': false } }, 'alert'), false);
});

test('pending, rejected, old, unlocated and unknown-area reports cannot trigger automatic broadcasts', () => {
  for (const change of [{status:'Pending'}, {status:'Rejected'}, {status:'Resolved'}, {verification:'Pending'},
    {createdAt:new Date(now-25*3600000)}, {createdAt:null}, {latitude:14.6}, {latitude:undefined}, {barangayId:'unknown'}, {createdAt:new Date(now+3600000)}]) {
    assert.equal(automaticReportAlert('r', {...report,...change}, now), null, JSON.stringify(change));
  }
});

test('road closures and restrictions trigger alerts but a passable road does not invent danger', () => {
  const road = {...report,type:'road',floodingLevel:'Knee Level',waterLevel:undefined};
  assert.equal(automaticReportAlert('r',{...road,roadStatus:'Not Passable'},now).priority,'Critical');
  assert.equal(automaticReportAlert('r',{...road,roadStatus:'Limited Access'},now).category,'Road Advisory');
  assert.equal(automaticReportAlert('r',{...road,roadStatus:'Passable'},now),null);
});

test('only fresh severe weather codes produce clearly labeled model advisories', () => {
  for (const weatherCode of [65,67,82,95,96,99]) {
    const candidate=automaticWeatherAlert({...weather,weatherCode},now);
    assert.equal(candidate.coverageArea,'municipality');assert.match(candidate.message,/model/);
    assert.notEqual(candidate.category,'Evacuation Notice');
  }
  for (const change of [{status:'stale'},{weatherCode:2},{weatherCode:null},{observedAt:new Date(now-2*3600000)},{location:{latitude:14.6,longitude:120.98}}]) {
    assert.equal(automaticWeatherAlert({...weather,...change},now),null);
  }
});

function storeFixture() {
  const records=new Map([['reports/r',report]]);let auditId=0;
  const doc=path=>({path,id:path.split('/').at(-1)});
  const store={doc,collection:name=>({doc:()=>doc(name+'/'+(++auditId))}),async runTransaction(callback){
    const writes=[];const result=await callback({get:async ref=>({exists:records.has(ref.path),data:()=>records.get(ref.path)}),
      set:(ref,data)=>writes.push([ref.path,data]),update:(ref,data)=>writes.push([ref.path,{...records.get(ref.path),...data}])});
    writes.forEach(([path,value])=>records.set(path,value));return result;
  }};
  return {store,records};
}

test('actual engine publishes once, updates escalation and closes withdrawn approvals with atomic audit records', async () => {
  const {store,records}=storeFixture();const engine=createAutomaticAlertEngine(store,{get:async()=>weather},()=>now);
  const path='alerts/'+automaticReportId('r');
  assert.equal(await engine.syncReport('r'),true);
  assert.equal(records.get(path).status,'active');assert.equal(records.get(path).createdByRole,'SYSTEM');
  assert.equal(await engine.syncReport('r'),false);
  records.set('reports/r',{...report,description:'Updated verified information'});
  assert.equal(await engine.syncReport('r'),true);
  records.set('reports/r',{...report,status:'Resolved'});
  assert.equal(await engine.syncReport('r'),true);assert.equal(records.get(path).status,'resolved');
  assert.equal(await engine.syncReport('r'),false);
  assert.equal([...records.keys()].filter(path=>path.startsWith('auditLogs/')).length,3);
  records.delete('reports/r');assert.equal(await engine.syncReport('r'),false);
});

test('weather repeats and outages do not spam or clear alerts; fresh benign weather resolves them',async()=>{
  const {store,records}=storeFixture();let current=weather;let time=now;
  const engine=createAutomaticAlertEngine(store,{get:async()=>current},()=>time);
  assert.equal(await engine.checkWeather(),true);
  const original=records.get('alerts/automatic_weather').publishedAt;
  time+=10*60000;current={...weather,observedAt:new Date(time).toISOString()};
  assert.equal(await engine.checkWeather(),false);assert.equal(records.get('alerts/automatic_weather').publishedAt,original);
  current={...current,status:'stale'};assert.equal(await engine.checkWeather(),false);assert.equal(records.get('alerts/automatic_weather').status,'active');
  current={...current,status:'available',weatherCode:2};assert.equal(await engine.checkWeather(),true);assert.equal(records.get('alerts/automatic_weather').status,'resolved');
});
