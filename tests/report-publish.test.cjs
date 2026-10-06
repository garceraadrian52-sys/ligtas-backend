const assert=require('node:assert/strict');const {test,before,after}=require('node:test');const express=require('express');
let alert,writeCount=0,audits=0,createdReport;
const db={doc(path){return {id:path.split('/').pop(),path,async get(){return {exists:true,data:()=>({})}}}},collection(){return {async add(data){createdReport=data;return {id:'report',async get(){return {id:'report',data:()=>data}}}}}},async runTransaction(callback){return callback({async get(){return {exists:!!alert,data:()=>alert}},update(_ref,updates){writeCount++;alert={...alert,...updates}}})}};
require.cache[require.resolve('../dist/config/firebaseAdmin')]={exports:{db}};
require.cache[require.resolve('../dist/middleware/auth')]={exports:{requireAuth(req,res,next){req.user={role:'LGU_ADMIN',uid:'tester',name:'Tester'};next()},requireOfficial(req,res,next){next()}}};
require.cache[require.resolve('../dist/services/auditLog')]={exports:{async logAction(){audits++}}};
const app=express();app.use(express.json());app.use('/alerts',require('../dist/routes/alerts').default);app.use('/reports',require('../dist/routes/reports').default);app.use('/users',require('../dist/routes/users').default);let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});base='http://127.0.0.1:'+server.address().port});after(()=>{server.closeAllConnections();server.close()});
const publish=()=>fetch(base+'/alerts/test/publish',{method:'PATCH'});
test('publishing twice keeps the original timestamp and records one write/audit',async()=>{alert={status:'draft',title:'Test'};writeCount=0;audits=0;assert.equal((await publish()).status,200);const publishedAt=alert.publishedAt;assert.equal((await publish()).status,200);assert.equal(writeCount,1);assert.equal(audits,1);assert.equal(alert.publishedAt,publishedAt)});
test('resolved/closed alerts cannot be reactivated through publish',async()=>{for(const status of ['resolved','closed']){alert={status};assert.equal((await publish()).status,409)}alert=null;assert.equal((await publish()).status,404)});
test('report inputs reject malformed fields and retain valid map coordinates',async()=>{
 const request=body=>fetch(base+'/reports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'flood',location:'Wawa',description:'Water on road',...body})});
 for(const body of [{location:' '},{description:{}},{latitude:14.8},{latitude:true,longitude:120},{barangayId:'a/b'},{waterLevel:{}}]){createdReport=null;assert.equal((await request(body)).status,400);assert.equal(createdReport,null)}
 assert.equal((await request({latitude:14.8,longitude:120.9})).status,201);assert.equal(createdReport.latitude,14.8);assert.equal(createdReport.longitude,120.9);
});

test('account creation rejects malformed names/passwords and unassigned officials',async()=>{
 for(const invalid of [{name:{}},{password:{}},{name:' '},{role:'BARANGAY_OFFICIAL'},{barangayId:'bad/path'}]){
 const response=await fetch(base+'/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Test',email:'test@example.com',password:'long-test-password',role:'LGU_ADMIN',...invalid})});assert.equal(response.status,400);
 }
});
