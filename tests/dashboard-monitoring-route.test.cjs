const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
let role='LGU_ADMIN',barangayId='wawa',weather=true;
const rows={reports:[{id:'a',type:'flood',status:'Verified',barangayId:'wawa',latitude:14.817733,longitude:120.895297,waterLevel:'Knee Deep',createdAt:new Date().toISOString()},
 {id:'b',type:'flood',status:'Verified',barangayId:'other',latitude:14.8187,longitude:120.9054,waterLevel:'Waist Deep',createdAt:new Date().toISOString()}],alerts:[],evacuationCenters:[]};
require.cache[require.resolve('../dist/config/firebaseAdmin')]={exports:{db:{collection(name){let list=rows[name];return {where(field,op,value){list=list.filter(row=>op==='in'?value.includes(row[field]):row[field]===value);return this;},async get(){return {docs:list.map(row=>({id:row.id,data:()=>row}))};}};}}}};
require.cache[require.resolve('../dist/middleware/auth')]={exports:{requireAuth(req,res,next){req.user={role,barangayId};next();},requireOfficial(req,res,next){next();}}};
require.cache[require.resolve('../dist/services/balagtasWeather')]={exports:{balagtasWeather:{get:async()=>weather?{location:{name:'Balagtas, Bulacan'},status:'available'}:null}}};
const app=express();app.use('/dashboard',require('../dist/routes/dashboard').default);
let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base=`http://127.0.0.1:${server.address().port}`;});
after(()=>{server.closeAllConnections();server.close();});
test('water trend uses only the authorized report snapshot while administrators include all local barangays',async()=>{
  role='BARANGAY_OFFICIAL';const official=await (await fetch(base+'/dashboard')).json();assert.equal(official.data.waterTrend.count,1);
  role='LGU_ADMIN';const admin=await (await fetch(base+'/dashboard')).json();assert.equal(admin.data.waterTrend.count,2);
});
test('weather is independent of dashboard records and caller-supplied locations do not change its scope',async()=>{
  const result=await fetch(base+'/dashboard/weather?latitude=0&longitude=0');assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal((await result.json()).data.location.name,'Balagtas, Bulacan');
  weather=false;assert.equal((await fetch(base+'/dashboard/weather')).status,503);assert.equal((await fetch(base+'/dashboard')).status,200);
});
