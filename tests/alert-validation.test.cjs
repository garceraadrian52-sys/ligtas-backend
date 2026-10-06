const assert=require('node:assert/strict');const {test,before,after}=require('node:test');const express=require('express');
require.cache[require.resolve('../dist/config/firebaseAdmin')]={exports:{db:{collection(){throw Error('Validation must happen before a database call')}}}};
require.cache[require.resolve('../dist/middleware/auth')]={exports:{requireAuth(req,res,next){req.user={role:'LGU_ADMIN',uid:'test'};next()},requireOfficial(req,res,next){next()}}};
const app=express();app.use(express.json());app.use('/alerts',require('../dist/routes/alerts').default);let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});base='http://127.0.0.1:'+server.address().port});after(()=>{server.closeAllConnections();server.close()});
test('invalid target cannot silently become a municipality-wide alert',async()=>{
 for(const bad of [{barangayIds:['typo']},{barangayIds:['__proto__']},{barangayIds:'wawa'},{title:'   '},{message:{}},{priority:'bad'},{publish:'false'},{title:'x'.repeat(161)}]){
 const response=await fetch(base+'/alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:'Flood Warning',priority:'High',title:'Test',message:'Test message',publish:false,...bad})});assert.equal(response.status,400,JSON.stringify(bad));
 }
});
