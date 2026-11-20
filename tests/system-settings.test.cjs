const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

process.env.LIGTAS_SYSTEM_VERSION = '1.0';
delete process.env.LIGTAS_LAST_UPDATED;
const writes = [];
let collectionReads = 0;
let probeFails = false;
const userPreferences = {};
const db = {
  doc(path) {
    return {
      async get() {
        if (path === 'systemSettings/backupStatus') return { exists: false, data: () => undefined };
        if (path === 'systemSettings/statusProbe') { if(probeFails)throw new Error('Unavailable');return { exists: false }; }
        if (path === 'userSettings/caller') return {data:()=>({...userPreferences})};
        throw new Error(`Unexpected document read: ${path}`);
      },
      async set(data) { writes.push({ path, data }); if(path==='userSettings/caller')Object.assign(userPreferences,data); },
    };
  },
  collection(name) {
    return {
      limit(max) {
        assert.equal(max, 501);
        return { async get() {
          collectionReads++;
          return { size: 1, docs: [{ id: 'record-1', data: () => ({ name: 'A record', password: 'never-export', privateToken: 'never-export', photoURL: 'data:image/png;base64,ZmFrZQ==' }) }] };
        } };
      },
    };
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) {
      req.user = { uid: 'caller', role: req.get('x-role') || 'LGU_ADMIN', name: 'Caller', email: 'caller@example.com' };
      next();
    },
  },
};
require.cache[require.resolve('../dist/services/auditLog')] = { exports: { auditActor:user=>({actorId:user.uid}),logAction: async () => undefined } };
require.cache[require.resolve('../dist/services/notificationWorker')] = { exports: { areNotificationWorkersStarted: () => false } };

const app = express();
app.use(express.json());
app.use('/settings', require('../dist/routes/settings').default);
let server;
let base;

before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}/settings`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test('system status is current, reports the worker runtime state and does not assert an unset update date', async () => {
  const response = await fetch(`${base}/system-status`, { headers: { 'x-role': 'SUPER_ADMIN' } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.version, '1.0');
  assert.equal(result.data.api, 'online');
  assert.equal(result.data.database, 'online');
  assert.equal(result.data.notifications, 'disabled');
  assert.equal(result.data.lastUpdated, null);
});

test('both administrator roles can check live status; database failure is never reported online and other roles are denied',async()=>{
 for(const role of ['SUPER_ADMIN','LGU_ADMIN']){
  const response=await fetch(`${base}/system-status`,{headers:{'x-role':role}});const {data}=await response.json();
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(Number.isFinite(Date.parse(data.checkedAt)));
 }
 probeFails=true;
 try{const {data}=await (await fetch(`${base}/system-status`,{headers:{'x-role':'LGU_ADMIN'}})).json();assert.equal(data.api,'online');assert.equal(data.database,'unavailable');}finally{probeFails=false;}
 for(const role of ['RESIDENT','BARANGAY_OFFICIAL'])assert.equal((await fetch(`${base}/system-status`,{headers:{'x-role':role}})).status,403);
});

test('administrative settings accept actual theme/inbox preferences and reject removed controls',async()=>{
 for(const role of ['SUPER_ADMIN','LGU_ADMIN']){
  const patch=body=>fetch(base,{method:'PATCH',headers:{'Content-Type':'application/json','x-role':role},body:JSON.stringify(body)});
  for(const body of [{autoBackup:true},{language:'Filipino'},{timezone:'UTC (GMT+0)'},{notifications:{email:true}}])assert.equal((await patch(body)).status,400);
  const response=await patch({theme:true,notifications:{push:true,critical:false,reports:false}});assert.equal(response.status,200);const {data}=await response.json();assert.equal(data.theme,true);assert.equal(data.notifications.reports,false);
  assert.deepEqual(Object.keys(data).sort(),['notifications','theme']);assert.equal('email' in data.notifications,false);
 }
});

test('version falls back to actual package metadata when no deployment version is set',async()=>{
 const previous=process.env.LIGTAS_SYSTEM_VERSION;delete process.env.LIGTAS_SYSTEM_VERSION;
 try{const {data}=await (await fetch(`${base}/system-status`,{headers:{'x-role':'LGU_ADMIN'}})).json();assert.equal(data.version,require('../package.json').version);}finally{process.env.LIGTAS_SYSTEM_VERSION=previous;}
});

test('system status omits malformed deployment timestamps and returns a valid ISO timestamp', async () => {
  process.env.LIGTAS_LAST_UPDATED = 'not-a-date';
  let response = await fetch(`${base}/system-status`, { headers: { 'x-role': 'SUPER_ADMIN' } });
  let result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.lastUpdated, null);

  process.env.LIGTAS_LAST_UPDATED = '2026-11-09T14:29:49.020Z';
  response = await fetch(`${base}/system-status`, { headers: { 'x-role': 'SUPER_ADMIN' } });
  result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.lastUpdated, '2026-11-09T14:29:49.020Z');

  delete process.env.LIGTAS_LAST_UPDATED;
});

test('partial backup is Super Admin only, bounded, redacts secrets and reports its unsupported restore scope', async () => {
  const denied = await fetch(`${base}/backup`, { method: 'POST', headers: { 'x-role': 'LGU_ADMIN' } });
  assert.equal(denied.status, 403);
  assert.equal(collectionReads, 0);

  const response = await fetch(`${base}/backup`, { method: 'POST', headers: { 'x-role': 'SUPER_ADMIN' } });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.data.partial, true);
  assert.equal(result.data.restoreSupported, false);
  assert.equal(result.data.collections.length, 5);
  const userRecord = result.data.collections.find(collection => collection.name === 'users').records[0];
  assert.equal(userRecord.id, 'record-1');
  assert.equal('password' in userRecord, false);
  assert.equal('privateToken' in userRecord, false);
  assert.equal(userRecord.photoURL, '[embedded image omitted from partial backup]');
  assert.equal(collectionReads, 5);
  assert.ok(writes.some(write=>write.path==='systemSettings/backupStatus'));
});
