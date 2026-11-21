const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
if(!process.env.FIRESTORE_EMULATOR_HOST){test('notification pagination integration',{skip:'Requires local Firestore emulator'},()=>{});}
else{
 assert.match(process.env.FIRESTORE_EMULATOR_HOST,/^127\.0\.0\.1:\d+$/);
 assert.equal(process.env.FIREBASE_PROJECT_ID,'demo-ligtas-tests');
 const express=require('express'),{Timestamp}=require('firebase-admin/firestore');
 const {db}=require('../dist/config/firebaseAdmin');
 const uid='pagination-fixture',prefix='pagination-fixture-';
 require.cache[require.resolve('../dist/middleware/auth')]={exports:{requireAuth(req,res,next){req.user={uid};next();}}};
 const app=express();app.use('/notifications',require('../dist/routes/notifications').default);
 let server,base;
 const paths=Array.from({length:126},(_,i)=>'notificationDeliveries/'+prefix+String(i).padStart(3,'0'));
 const other='notificationDeliveries/'+prefix+'other',missing='notificationDeliveries/'+prefix+'missing',legacy='notificationDeliveries/'+prefix+'legacy';
 before(async()=>{
  const batch=db.batch();
  paths.forEach((path,i)=>batch.set(db.doc(path),{userId:uid,title:'Notice '+i,body:'Owner data',createdAt:Timestamp.fromMillis(1700000000000+Math.min(i,20)*1000),...(i===1?{}:{read:i===0})}));
  batch.set(db.doc(other),{userId:'different-owner',title:'Private notice',createdAt:Timestamp.now(),read:false});await batch.commit();
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port+'/notifications/inbox?pageSize=20';
 });
 after(async()=>{server?.closeAllConnections();server?.close();const batch=db.batch();[...paths,other,missing,legacy].forEach(path=>batch.delete(db.doc(path)));await batch.commit();});
 test('bounded owner pages retain complete history, timestamp ties and unread totals beyond the loaded page',async()=>{
  const first=await fetch(base);assert.equal(first.status,200);const {data:a}=await first.json();
  assert.equal(a.items.length,20);assert.equal(a.unreadCount,125);assert.equal(a.hasMore,true);assert.ok(a.nextCursor);
  const all=[...a.items];let next=a.nextCursor,last;
  while(next){const {data}=await (await fetch(base+'&cursor='+encodeURIComponent(next))).json();all.push(...data.items);next=data.nextCursor;last=data;}
  assert.equal(last.items.length,6);assert.equal(last.hasMore,false);
  assert.equal(new Set(all.map(item=>item.id)).size,126);
  assert.ok(all.every(item=>item.title!=='Private notice'));
  assert.equal((await db.doc(paths[0]).get()).data().read,true);
 });
 test('foreign, deleted and malformed cursors and invalid limits are rejected without exposing notification data',async()=>{
  for(const suffix of ['&cursor='+prefix+'other','&cursor=missing-record','&cursor=bad%2Fpath'])assert.equal((await fetch(base+suffix)).status,400);
  for(const size of ['0','101','abc'])assert.equal((await fetch(base.replace('20',size))).status,400);
 });
 test('old records with missing or string dates and absent read flags remain accessible through compatible pages',async()=>{
  await db.doc(missing).set({userId:uid,title:'Legacy missing date'});
  await db.doc(legacy).set({userId:uid,title:'Legacy string date',createdAt:'2020-01-01T00:00:00Z'});
  const {data:a}=await (await fetch(base)).json();const all=[...a.items];let next=a.nextCursor;
  while(next){const {data}=await (await fetch(base+'&cursor='+encodeURIComponent(next))).json();all.push(...data.items);next=data.nextCursor;}
  assert.equal(a.unreadCount,127);assert.equal(new Set(all.map(item=>item.id)).size,128);
  assert.ok(all.some(item=>item.title==='Legacy missing date'));assert.ok(all.some(item=>item.title==='Legacy string date'));
 });
 test('a missing composite index preserves readable history; quota failures stay retryable instead of becoming empty inboxes',async()=>{
  const original=db.runTransaction;
  try{
   db.runTransaction=async()=>{throw Object.assign(new Error('missing index'),{code:9});};
   const response=await fetch(base);assert.equal(response.status,200);const {data}=await response.json();assert.equal(data.items.length,20);assert.equal(data.unreadCount,127);
   db.runTransaction=async()=>{throw Object.assign(new Error('quota'),{code:8});};
   const failed=await fetch(base);assert.equal(failed.status,503);assert.equal(failed.headers.get('retry-after'),'5');
  }finally{db.runTransaction=original;}
 });
}
