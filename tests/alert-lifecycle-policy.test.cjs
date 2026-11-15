const {test}=require('node:test');const assert=require('node:assert/strict');const {alertLifecycle,alertValidity,storedAlertValidity}=require('../dist/services/alertLifecycle');const {summarizeDashboard}=require('../dist/services/dashboardSummary');
test('manual alerts never time out, scheduled alerts expire at the exact boundary, and cancelled flags win',()=>{const now=1800000000000;assert.equal(alertLifecycle({status:'published',validityMode:'manual',expiresAt:new Date(now-1)},now),'published');assert.equal(alertLifecycle({status:'published',expiresAt:{seconds:now/1000}},now),'expired');assert.equal(alertLifecycle({status:'published',validityMode:'scheduled'},now),'expired');assert.equal(alertLifecycle({status:'active',deactivatedAt:new Date()},now),'deactivated');assert.equal(alertValidity({validityMode:'manual'}).expiresAt,null);});
test('dashboard caps at five, orders Critical High Normal Low Unspecified and ties by newest publication',()=>{const now=Date.now();const alerts=['Normal','Low','High','Critical','Critical',null,'High'].map((priority,i)=>({id:String(i),priority,status:'published',publishedAt:new Date(now+i)}));alerts.push({id:'deactivated',status:'deactivated',priority:'Critical'},{id:'expired',status:'published',priority:'Critical',expiresAt:new Date(now-1)});const result=summarizeDashboard([],alerts,[],now);assert.deepEqual(result.recentAlerts.map(item=>item.id),['4','3','6','2','0']);assert.equal(result.activeAlerts,7);});

test('server validation rejects calendar rollover instead of silently accepting another date',()=>{for(const expiresAt of ['2099-02-30T12:00:00+08:00','2099-13-01T00:00:00Z','2099-01-01T25:00:00Z'])assert.throws(()=>alertValidity({validityMode:'scheduled',expiresAt}));});

test('legacy request validity matches historical no-expiry behavior without accepting invalid deadlines',()=>{
 const now=1800000000000,future=new Date(now+60000).toISOString();
 assert.deepEqual(alertValidity({},now),{validityMode:'manual',expiresAt:null});
 assert.deepEqual(alertValidity({expiresAt:null},now),{validityMode:'manual',expiresAt:null});
 assert.equal(alertValidity({expiresAt:future},now).expiresAt.toISOString(),future);
 for(const body of [{validityMode:null},{validityMode:''},{expiresAt:'bad'},{expiresAt:'2020-01-01T00:00:00Z'},{expiresAt:'2099-01-01T00:00'},{expiresAt:{seconds:now/1000+60}}])assert.throws(()=>alertValidity(body,now));
});

test('stored legacy validity retains timestamps and never invents a replacement deadline',()=>{
 const timestamp={toMillis:()=>1800000000123};
 assert.deepEqual(storedAlertValidity({}),{validityMode:'manual',expiresAt:null});
 assert.equal(storedAlertValidity({expiresAt:timestamp}).expiresAt,timestamp);
 assert.equal(storedAlertValidity({expiresAt:timestamp}).validityMode,'scheduled');
 const expired=new Date('2020-01-01T00:00:00Z');
 assert.equal(storedAlertValidity({expiresAt:expired}).expiresAt,expired);
 for(const data of [{expiresAt:'bad'},{validityMode:'scheduled',expiresAt:null},{validityMode:'unknown'}])assert.throws(()=>storedAlertValidity(data),/INVALID_VALIDITY/);
});
