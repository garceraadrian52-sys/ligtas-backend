const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');
const records = new Map(); let nextId = 0;
const ref = path => ({ path, id: path.split('/')[1] });
const db = {
 doc: ref,
 collection: name => ({ doc: () => ref(name + '/' + (++nextId)), orderBy() { return this; }, async get() { return { docs: [...records].filter(([path]) => path.startsWith(name + '/')).map(([path, data]) => ({ id: ref(path).id, data: () => data })) }; } }),
 async runTransaction(work) { return work({ get: async r => ({ exists: records.has(r.path), data: () => records.get(r.path) }), create: (r,d) => records.set(r.path,d), set: (r,d) => records.set(r.path,d), update: (r,d) => records.set(r.path,{...records.get(r.path),...d}), delete: r => records.delete(r.path) }); }
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { logAction: async () => {} } };
require.cache[require.resolve('../dist/middleware/auth')] = { exports: { requireAuth(req,res,next) { req.user = { role: req.headers['x-role'] || 'LGU_ADMIN', uid:'admin',name:'Admin' }; next(); }, requireOfficial(req,res,next) { next(); } } };
const app = express(); app.use(express.json()); app.use('/alerts',require('../dist/routes/alerts').default);
let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;});
after(()=>{server.closeAllConnections();server.close();});
const content={category:'Flood Warning',priority:'High',title:'Flood advisory',message:'Prepare supplies.',barangayIds:['barangay_dalig'],publish:false};
async function request(path='',method='GET',body,role='LGU_ADMIN') { const response=await fetch(base+'/alerts'+path,{method,headers:{'Content-Type':'application/json','x-role':role},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()}; }
test('draft persists, edits, publishes idempotently, and rejects later edits/deletion',async()=>{
 const created=await request('','POST',content);assert.equal(created.status,201);const id=created.data.id;
 assert.equal(created.data.status,'draft');assert.equal(created.data.publishedAt,null);
 assert.equal((await request()).data.find(a=>a.id===id).message,content.message);
 assert.ok(!(await request('','GET',null,'BARANGAY_OFFICIAL')).data.some(a=>a.id===id));
 const edited=await request('/'+id,'PATCH',{...content,message:'Updated supplies.',barangayIds:['barangay_wawa']});assert.equal(edited.status,200);assert.equal(edited.data.status,'draft');assert.equal(edited.data.description,'Updated supplies.');assert.deepEqual(edited.data.locationScope.barangayIds,['barangay_wawa']);
 const published=await request('/'+id+'/publish','PATCH');assert.equal(published.status,200);assert.equal(published.data.status,'published');assert.ok(published.data.publishedAt);
 assert.equal((await request('/'+id+'/publish','PATCH')).data.publishedAt,published.data.publishedAt);
 assert.equal((await request('/'+id,'PATCH',content)).status,409);assert.equal((await request('/'+id,'DELETE')).status,409);
});
test('authorized Superadmin deletes drafts permanently and missing records return 404',async()=>{
 const created=await request('','POST',content,'SUPER_ADMIN');const path='/'+created.data.id;
 assert.equal((await request(path,'DELETE',null,'SUPER_ADMIN')).status,200);
 assert.ok(!(await request()).data.some(a=>a.id===created.data.id));
 assert.equal((await request(path,'DELETE')).status,404);assert.equal((await request(path,'PATCH',content)).status,404);assert.equal((await request(path+'/publish','PATCH')).status,404);
});
test('residents and barangay officials cannot manage drafts',async()=>{
 const created=await request('','POST',content);const path='/'+created.data.id;
 for(const role of ['RESIDENT','BARANGAY_OFFICIAL']) for(const [suffix,method,body] of [['','POST',content],[path,'PATCH',content],[path,'DELETE'],[path+'/publish','PATCH']]) assert.equal((await request(suffix,method,body,role)).status,403);
 assert.equal(records.get('alerts/'+created.data.id).status,'draft');
});
test('direct publication uses published status and malformed draft changes are rejected',async()=>{
 assert.equal((await request('','POST',{...content,publish:true})).data.status,'published');
 const created=await request('','POST',content);assert.equal((await request('/'+created.data.id,'PATCH',{...content,barangayIds:['invalid']})).status,400);
});
