const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findHouseholdByDisplayId, normalizeHouseholdDisplayId, parseHouseholdJoinReference } = require('../dist/services/householdReference');

function memoryFirestore(records) {
  return {
    collection(name) {
      assert.equal(name, 'households');
      return { where(field, operator, value) {
        assert.deepEqual([field, operator], ['displayId', '==']);
        return { async get() {
          const docs = records.filter(record => record.displayId === value).map(record => ({ id: record.id, data: () => record }));
          return { docs };
        } };
      } };
    },
  };
}

test('household reference input is normalized and rejects arbitrary document identifiers', () => {
  assert.equal(normalizeHouseholdDisplayId('hh-00012'), 'HH-00012');
  assert.equal(normalizeHouseholdDisplayId('H-private-doc-id'), null);
  assert.equal(normalizeHouseholdDisplayId('HH-12'), null);
});

test('household reference resolution returns only a same-barangay internal route key', async () => {
  const db = memoryFirestore([
    { id: 'secret-internal-a', displayId: 'HH-00012', barangayId: 'wawa', street: 'private' },
    { id: 'secret-internal-b', displayId: 'HH-00012', barangayId: 'borol_1st', street: 'private' },
  ]);
  const result = await findHouseholdByDisplayId(db, 'HH-00012', 'borol_1st');
  assert.deepEqual(result, { kind: 'found', id: 'secret-internal-b' });
  assert.equal(Object.hasOwn(result, 'street'), false);
});

test('missing and duplicate local household references are reported without returning another area record', async () => {
  assert.deepEqual(await findHouseholdByDisplayId(memoryFirestore([
    { id: 'other-area', displayId: 'HH-00012', barangayId: 'wawa' },
  ]), 'HH-00012', 'borol_1st'), { kind: 'missing' });
  assert.deepEqual(await findHouseholdByDisplayId(memoryFirestore([
    { id: 'a', displayId: 'HH-00012', barangayId: 'borol_1st' },
    { id: 'b', displayId: 'HH-00012', barangayId: 'borol_1st' },
  ]), 'HH-00012', 'borol_1st'), { kind: 'duplicate' });
});

test('join accepts display aliases and legacy QR document keys without accepting arbitrary paths', () => {
  const aliases = { displayIds: ['HH-00001', 'HH-0001'] };
  assert.deepEqual(parseHouseholdJoinReference('hh-0001'), aliases);
  assert.deepEqual(parseHouseholdJoinReference(' HH-00001 '), aliases);
  assert.deepEqual(parseHouseholdJoinReference('HH-10000'), { displayIds: ['HH-10000'] });
  assert.deepEqual(parseHouseholdJoinReference('h-abcde'), { id: 'H-ABCDE' });
  for (const invalid of ['HH-123', 'households/H-ABCDE', 'https://example.test/HH-00001', null]) {
    assert.equal(parseHouseholdJoinReference(invalid), null);
  }
});


const enabled = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);
test('authenticated QR and code joins remain pending until the head approves', { skip: !enabled }, async (t) => {
  process.env.FIREBASE_PROJECT_ID = 'demo-ligtas-tests';
  const express = require('express');
  const { db } = require('../dist/config/firebaseAdmin');
  const app = express(); app.use(express.json()); app.use('/households', require('../dist/routes/households').default);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(async () => { server.closeAllConnections(); server.close(); await db.terminate(); });
  const signUp = async () => {
    const response = await fetch('http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    });
    assert.equal(response.status, 200); return response.json();
  };
  const applicant = await signUp(), head = await signUp();
  const householdId = 'H-AUTHJOIN';
  await Promise.all([
    db.doc('users/' + applicant.localId).set({ role: 'RESIDENT', name: 'Applicant', barangayId: 'wawa' }),
    db.doc('users/' + head.localId).set({ role: 'RESIDENT', name: 'Head', barangayId: 'wawa', householdId }),
    db.doc('households/' + householdId).set({ displayId: 'HH-00421', name: 'Household', head: 'Head', barangayId: 'wawa', createdBy: head.localId, memberUids: [head.localId], street: 'Private', contact: 'Private',
      members: [{ id: 'head', userId: head.localId, name: 'Head', relationship: 'Head' }, { id: 'manual', name: 'Member', relationship: 'Niece' }] }),
  ]);
  const post = (path, token, body) => fetch('http://127.0.0.1:' + server.address().port + '/households' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await post('/preview', null, { reference: 'HH-00421' })).status, 401);
  for (const reference of ['HH-00421', JSON.stringify({ app: 'ligtas', version: 1, householdId })]) {
    const response = await post('/preview', applicant.idToken, { reference }); assert.equal(response.status, 200);
    const preview = (await response.json()).data; assert.equal(preview.members.length, 2); assert.equal(preview.contact, undefined); assert.equal(preview.street, undefined);
  }
  const request = async () => {
    const response = await post('/join', applicant.idToken, { reference: 'HH-00421', memberId: 'manual', userId: 'forged' });
    assert.equal(response.status, 201); return (await response.json()).data;
  };
  let pending = await request();
  assert.equal((await db.doc('users/' + applicant.localId).get()).get('householdId'), undefined);
  assert.equal((await post('/join', applicant.idToken, { reference: householdId, memberId: 'manual' })).status, 409);
  assert.equal((await post('/requests/' + pending.id + '/decision', head.idToken, { approve: false })).status, 200);
  pending = await request();
  assert.equal((await post('/requests/' + pending.id + '/decision', head.idToken, { approve: true })).status, 400);
  assert.equal((await post('/requests/' + pending.id + '/decision', head.idToken, { approve: true, identityConfirmed: true })).status, 200);
  const members = (await db.doc('households/' + householdId).get()).get('members');
  assert.equal(members.length, 2); assert.equal(members[1].id, 'manual'); assert.equal(members[1].userId, applicant.localId);
});
