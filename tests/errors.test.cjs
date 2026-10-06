const { test, before, after } = require('node:test');
const assert=require('node:assert/strict');const express=require('express');
const { errorHandler,notFound }=require('../dist/middleware/errorHandler');
const app=express();app.use(express.json({limit:'1kb'}));app.post('/body',(req,res)=>res.json(req.body));app.get('/fail',()=>{throw new Error('private internal details')});app.use(notFound);app.use(errorHandler);
let server,base;before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});base='http://127.0.0.1:'+server.address().port});after(()=>{server.closeAllConnections();server.close()});
test('unknown routes and malformed/oversized JSON use safe JSON errors',async()=>{
 for(const [path,options,status] of [['/missing',{},404],['/body',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'},400],['/body',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(2000)})},413],['/fail',{},500]]){
 const res=await fetch(base+path,options);assert.equal(res.status,status);const data=await res.json();assert.equal(typeof data.error,'string');assert.ok(!data.error.includes('private internal'));
 }
});
