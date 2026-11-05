const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const policy = require('../dist/services/notificationPolicy');

test('delivery revisions are stable when Firestore changes the order of scope map keys', () => {
  const alert={title:'Flood',message:'Verified danger',locationScope:{type:'barangay',barangayIds:['barangay_dalig']}};
  assert.equal(policy.alertRevision('r',alert),policy.alertRevision('r',{...alert,locationScope:{barangayIds:['barangay_dalig'],type:'barangay'}}));
});

test('the real alert watcher recovers automatic publications after restart without replaying manual alerts or duplicating jobs', async () => {
  const callbacks=new Map(), jobs=new Map();let ready=0;
  const resident={role:'RESIDENT',barangayId:'barangay_dalig'};
  const user={id:'resident',data:()=>resident};
  const device={ref:{path:'users/resident/devices/phone'}};
  function collection(name) {
    const query={onSnapshot:callback=>callbacks.set(name,callback),where:()=>query,orderBy:()=>query,limit:()=>query,startAfter:()=>query,
      get:async()=>({docs:name==='users'?[user]:name.includes('/devices')?[device]:[],size:1}),
      doc:id=>({get:async()=>({data:()=>jobs.get(id)}),create:async data=>{if(jobs.has(id))throw {code:6};jobs.set(id,data);}})};
    return query;
  }
  const exports={};
  vm.runInNewContext(readFileSync(require.resolve('../dist/services/notificationWorker'),'utf8'),{
    exports,setInterval:()=>0,console:{log(){},error(){}},Date,
    require:name=>name==='node:crypto'?require(name):name.includes('firebaseAdmin')?{db:{collection}}:name.includes('notificationPolicy')?policy:
      name==='firebase-admin/firestore'?{Timestamp:{now:()=>({toMillis:()=>Date.now()}),fromMillis:value=>({toMillis:()=>value})},FieldValue:{}}:null,
  });
  exports.startNotificationWorkers(()=>ready++);
  const make=(id,automatic)=>({id,ref:{path:'alerts/'+id},data:()=>({title:'Flood',message:'Verified danger',automatic,status:'active',coverageArea:'barangay',barangayId:'barangay_dalig'})});
  const docs=[make('automatic',true),make('manual',false)];
  const snapshot={docs,size:2,docChanges:()=>docs.map(doc=>({type:'added',doc}))};
  await callbacks.get('alerts')(snapshot);
  assert.equal(ready,1);assert.equal(jobs.size,1);assert.equal([...jobs.values()][0].targetId,'automatic');
  await callbacks.get('alerts')({docs:[docs[0]],size:1,docChanges:()=>[{type:'modified',doc:docs[0]}]});
  assert.equal(jobs.size,1);
});
