const { test } = require('node:test');
const assert = require('node:assert/strict');
const writes = [];
require.cache[require.resolve('../dist/config/firebaseAdmin')] = {
  exports: { db: { collection: () => ({
    add: async record => writes.push(record),
    doc: () => ({ create: async record => writes.push(record) }),
  }) } },
};
const { logAction, logActionInTransaction } = require('../dist/services/auditLog');
const { canViewAuditLog } = require('../dist/services/auditAccess');
const activity = { actorId:'resident-id',actorName:'Resident',actorRole:'RESIDENT',action:'login_succeeded',targetType:'user',targetId:'resident-id' };

test('resident operations never create regular or transactional audit entries', async () => {
  await logAction(activity);
  await logAction({...activity,actorRole:'resident',eventId:'login'});
  logActionInTransaction({create:(_ref,record)=>writes.push(record)},activity);
  assert.equal(writes.length,0);
  await logAction({...activity,actorId:'official-id',actorRole:'BARANGAY_OFFICIAL'});
  assert.equal(writes.length,1);
});

test('resident history is excluded while personnel actions involving resident accounts remain visible', () => {
  for (const role of ['SUPER_ADMIN','LGU_ADMIN']) {
    assert.equal(canViewAuditLog({uid:'admin',role},activity),false);
    assert.equal(canViewAuditLog({uid:'admin',role},{...activity,actorId:'admin',actorRole:role,action:'user_deactivated',details:{role:'RESIDENT'}}),true);
  }
});
