const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');
const records = new Map(); let nextId = 0; let auditFailure=false;
const ref = path => ({ path, id: path.split('/')[1] });
const db = {
 doc: ref,
 collection: name => ({ doc: () => ref(name + '/' + (++nextId)), orderBy() { return this; }, async get() { return { docs: [...records].filter(([path]) => path.startsWith(name + '/')).map(([path, data]) => ({ id: ref(path).id, data: () => data })) }; } }),
 async runTransaction(work) {const writes=[];const result=await work({get:async r=>({exists:records.has(r.path),data:()=>records.get(r.path)}),create:(r,d)=>{if(auditFailure&&r.path.startsWith('auditLogs/'))throw Error('audit unavailable');writes.push(()=>records.set(r.path,d))},set:(r,d)=>writes.push(()=>records.set(r.path,d)),update:(r,d)=>writes.push(()=>records.set(r.path,{...records.get(r.path),...d})),delete:r=>writes.push(()=>records.delete(r.path))});writes.forEach(write=>write());return result; }
};
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };

require.cache[require.resolve('../dist/middleware/auth')] = { exports: { requireAuth(req,res,next) { req.user = { role: req.headers['x-role'] || 'LGU_ADMIN', uid:'admin',name:'Admin' }; next(); }, requireOfficial(req,res,next) { next(); } } };
const app = express(); app.use(express.json()); app.use('/alerts',require('../dist/routes/alerts').default);
let server,base;
before(async()=>{server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+server.address().port;});
after(()=>{server.closeAllConnections();server.close();});
const content={category:'Flood Warning',priority:'High',title:'Flood advisory',message:'Prepare supplies.',barangayIds:['barangay_dalig'],publish:false,validityMode:'manual'};
async function request(path='',method='GET',body,role='LGU_ADMIN') { const response=await fetch(base+'/alerts'+path,{method,headers:{'Content-Type':'application/json','x-role':role},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,...await response.json()}; }
test('draft persists, edits and publishes idempotently; active editing is controlled and deletion is forbidden',async()=>{
 const created=await request('','POST',content);assert.equal(created.status,201);const id=created.data.id;
 assert.equal(created.data.status,'draft');assert.equal(created.data.publishedAt,null);
 assert.equal((await request()).data.find(a=>a.id===id).message,content.message);
 assert.ok(!(await request('','GET',null,'BARANGAY_OFFICIAL')).data.some(a=>a.id===id));
 const edited=await request('/'+id,'PATCH',{...content,message:'Updated supplies.',barangayIds:['barangay_wawa']});assert.equal(edited.status,200);assert.equal(edited.data.status,'draft');assert.equal(edited.data.description,'Updated supplies.');assert.deepEqual(edited.data.locationScope.barangayIds,['barangay_wawa']);
 const published=await request('/'+id+'/publish','PATCH');assert.equal(published.status,200);assert.equal(published.data.status,'published');assert.ok(published.data.publishedAt);
 assert.equal((await request('/'+id+'/publish','PATCH')).data.publishedAt,published.data.publishedAt);
 assert.equal((await request('/'+id,'PATCH',{...content,message:'Updated active instructions.'})).status,200);assert.equal((await request('/'+id,'DELETE')).status,409);
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


test('validity selection is mandatory and server time rejects missing, invalid or past expiration',async()=>{
 for(const values of [{validityMode:undefined},{validityMode:'unknown'},{validityMode:'scheduled'},{validityMode:'scheduled',expiresAt:'bad'},{validityMode:'scheduled',expiresAt:'2020-01-01T00:00:00Z'},{validityMode:'scheduled',expiresAt:'2099-01-01T00:00'}])assert.equal((await request('','POST',{...content,...values})).status,400);
 const future=new Date(Date.now()+60000).toISOString();
 const result=await request('','POST',{...content,publish:true,validityMode:'scheduled',expiresAt:future});assert.equal(result.status,201);assert.equal(result.data.expiresAt,future);
 const manual=await request('','POST',{...content,validityMode:'manual',expiresAt:'2020-01-01T00:00:00Z'});assert.equal(manual.data.expiresAt,null);
});

test('controlled active edits preserve publication time and audit exact changes atomically',async()=>{
 const created=await request('','POST',{...content,publish:true});const path='/'+created.data.id;
 const longMessage='Safety instruction. '.repeat(100);
 const result=await request(path,'PATCH',{...content,message:longMessage,title:'Updated advisory',priority:'Critical',expectedRevision:1,barangayIds:['barangay_wawa']});assert.equal(result.status,200);assert.equal(result.data.publishedAt,created.data.publishedAt);assert.equal(result.data.status,'published');assert.equal(result.data.revision,2);
 const audit=[...records.values()].find(item=>item.action==='alert_updated'&&item.targetId===created.data.id);
 assert.equal(audit.actorId,'admin');assert.equal(audit.outcome,'success');assert.equal(audit.details.before.title,content.title);assert.equal(audit.details.after.message,longMessage.trim());assert.ok(audit.details.changedFields.includes('priority'));
 assert.equal((await request(path,'PATCH',{...content,expectedRevision:1})).status,409);
});

test('deactivation requires a reason, retains historical data, and cannot be reversed or edited',async()=>{
 const created=await request('','POST',{...content,publish:true});const path='/'+created.data.id;
 assert.equal((await request(path+'/deactivate','PATCH',{reason:'  '})).status,400);
 for(const role of ['BARANGAY_OFFICIAL','RESIDENT'])assert.equal((await request(path+'/deactivate','PATCH',{reason:'Conditions improved'},role)).status,403);
 const result=await request(path+'/deactivate','PATCH',{reason:'  Advisory superseded by updated instructions.  '});assert.equal(result.status,200);assert.equal(result.data.status,'deactivated');assert.equal(result.data.deactivatedBy,'admin');assert.equal(result.data.deactivatedByName,'Admin');assert.ok(result.data.deactivatedAt);assert.equal(result.data.deactivationReason,'Advisory superseded by updated instructions.');
 for(const [suffix,method,body] of [['','PATCH',content],['/publish','PATCH'],['/deactivate','PATCH',{reason:'Again'}],['','DELETE']])assert.equal((await request(path+suffix,method,body)).status,409);
 assert.ok((await request()).data.some(item=>item.id===created.data.id));
 const audits=[...records.values()].filter(item=>item.action==='alert_deactivated'&&item.targetId===created.data.id);assert.equal(audits.length,1);assert.equal(audits[0].details.reason,result.data.deactivationReason);
});

test('expiration blocks edits, publication, deactivation and deletion using server time',async()=>{
 const created=await request('','POST',{...content,publish:true});records.set('alerts/'+created.data.id,{...records.get('alerts/'+created.data.id),validityMode:'scheduled',expiresAt:new Date(Date.now()-1)});
 for(const [suffix,method,body] of [['','PATCH',content],['/publish','PATCH'],['/deactivate','PATCH',{reason:'Late cancellation'}],['','DELETE']])assert.equal((await request('/'+created.data.id+suffix,method,body)).status,409);
 const draft=await request('','POST',{...content,validityMode:'scheduled',expiresAt:new Date(Date.now()+60000).toISOString()});records.get('alerts/'+draft.data.id).expiresAt=new Date(Date.now()-1);assert.equal((await request('/'+draft.data.id+'/publish','PATCH')).status,409);
});

test('failed audit writes roll back active edits and deactivation',async()=>{
 const created=await request('','POST',{...content,publish:true});auditFailure=true;
 try{assert.equal((await request('/'+created.data.id,'PATCH',{...content,title:'Must not persist'})).status,500);assert.equal(records.get('alerts/'+created.data.id).title,content.title);assert.equal((await request('/'+created.data.id+'/deactivate','PATCH',{reason:'Must not persist'})).status,500);assert.equal(records.get('alerts/'+created.data.id).status,'published');}finally{auditFailure=false;}
});
