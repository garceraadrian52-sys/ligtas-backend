const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const express=require('express');
const records=Array.from({length:502},(_,i)=>({id:String(i),userId:'mine',createdAt:{seconds:i+1},title:'Item',...(i===0?{read:true}:i===1?{}:{read:false})}));
records.push({id:'other',userId:'other',read:false});
const batches=[];
const doc=item=>({id:item.id,data:()=>item,ref:{id:item.id}});
const db={collection(){let owner;return {where(field,op,value){assert.equal(field,'userId');owner=value;return this},select(){return this},async get(){return {docs:records.filter(item=>item.userId===owner).map(doc)}}}},
  batch(){const ids=[];return {update(ref){ids.push(ref.id)},async commit(){batches.push(ids);ids.forEach(id=>{records.find(r=>r.id===id).read=true})}}},
  doc(path){const item=records.find(r=>r.id===path.split('/')[1]);return {async get(){return {exists:!!item,data:()=>item}},async update(){throw Error('Unauthorized update')}}}};
require.cache[require.resolve('../dist/config/firebaseAdmin')]={exports:{db}};
require.cache[require.resolve('../dist/middleware/auth')]={exports:{requireAuth(req,res,next){req.user={uid:'mine'};next()}}};
const app=express();app.use('/notifications',require('../dist/routes/notifications').default);
let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}`});
after(()=>{server.closeAllConnections();server.close()});
test('inbox counts unread beyond the preview and 100-item list, including absent read fields',async()=>{
 const response=await fetch(base+'/notifications/inbox');const {data}=await response.json();
 assert.equal(response.status,200);assert.equal(data.unreadCount,501);assert.equal(data.items.length,100);assert.equal(data.items[0].id,'501');assert.ok(data.items.every(item=>item.userId==='mine'));
});
test('notifications from another user cannot be marked read',async()=>{
 assert.equal((await fetch(base+'/notifications/other',{method:'PATCH'})).status,403);
});
test('mark all includes legacy unread records and splits Firestore batches',async()=>{
 const response=await fetch(base+'/notifications/read-all',{method:'PATCH'});assert.equal(response.status,200);
 assert.equal((await response.json()).data.updated,501);assert.deepEqual(batches.map(b=>b.length),[450,51]);assert.equal(records.find(r=>r.id==='other').read,false);
});
