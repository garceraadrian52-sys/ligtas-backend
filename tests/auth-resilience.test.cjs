const assert=require('node:assert/strict');const {test,before,after}=require('node:test');const express=require('express');
let mode='valid',profile={role:'LGU_ADMIN',name:'Admin'};
require.cache[require.resolve('../dist/config/firebaseAdmin')]={exports:{auth:{async verifyIdToken(){if(mode==='expired')throw {code:'auth/id-token-expired'};return {uid:'test'}}},db:{doc(){return {async get(){if(mode==='offline')throw {code:14};return {data:()=>profile}}}}}}};
const {requireAuth,requireOfficial}=require('../dist/middleware/auth');const app=express();app.get('/private',requireAuth,requireOfficial,(req,res)=>res.json({ok:true}));let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});base='http://127.0.0.1:'+server.address().port});after(()=>{server.closeAllConnections();server.close()});
const read=()=>fetch(base+'/private',{headers:{Authorization:'Bearer test'}});
test('temporary profile failures are 503, expired tokens are 401',async()=>{mode='offline';assert.equal((await read()).status,503);mode='expired';assert.equal((await read()).status,401);mode='valid';assert.equal((await read()).status,200)});
test('official access requires an assigned barangay while LGU access does not',async()=>{mode='valid';profile={role:'BARANGAY_OFFICIAL',barangayId:null};assert.equal((await read()).status,403);profile.barangayId='barangay_wawa';assert.equal((await read()).status,200);profile={role:'RESIDENT'};assert.equal((await read()).status,403)});
