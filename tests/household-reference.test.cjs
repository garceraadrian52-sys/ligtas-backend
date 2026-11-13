const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findHouseholdByDisplayId, normalizeHouseholdDisplayId, parseHouseholdJoinReference } = require('../dist/services/householdReference');

function memoryFirestore(records) {
  return {
    collection(name) {
      assert.equal(name, 'households');
      return { where(field, operator, value) {
        assert.deepEqual([field, operator], ['displayId', 'in']);
        return { async get() {
          const docs = records.filter(record => value.includes(record.displayId)).map(record => ({ id: record.id, data: () => record }));
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
test('authenticated cross-barangay join is private, atomic, and allows reapplying after rejection', { skip: !enabled }, async (t) => {
  process.env.FIREBASE_PROJECT_ID = 'demo-ligtas-tests';
  const express = require('express');
  const { db } = require('../dist/config/firebaseAdmin');
  const app = express();
  app.use(express.json());
  app.use('/households', require('../dist/routes/households').default);
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await db.terminate();
  });

  const signUp = async () => {
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const { localId: uid, idToken } = await signUp();
  const { localId: officialUid, idToken: officialToken } = await signUp();
  const profile = db.doc(`users/${uid}`);
  const household = db.doc('households/H-TEST1');
  const request = db.doc(`householdRequests/H-TEST1_${uid}`);
  const householdData = { displayId: 'HH-00001', barangayId: 'barangay_wawa', createdBy: 'head', street: 'private test address', memberUids: ['head'] };
  await Promise.all([
    profile.set({ role: 'resident', name: 'Applicant', barangayId: 'barangay_borol' }),
    db.doc(`users/${officialUid}`).set({ role: 'BARANGAY_OFFICIAL', barangayId: 'barangay_wawa' }),
    household.set(householdData),
  ]);
  const join = async (reference, token = idToken, relationship = ' Niece ') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/households/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ reference, relationship, userId: 'forged', status: 'Approved' }),
    });
    return [response.status, await response.json()];
  };
  assert.equal((await join('HH-00001', null))[0], 401);
  assert.equal((await join('HH-00001', officialToken))[0], 403);
  assert.equal((await join('HH-00001', idToken, ' '))[0], 400);
  assert.equal((await join('HH-001'))[0], 400);
  assert.equal((await join('HH-00010'))[0], 404);
  assert.equal((await join('H-WRONG'))[0], 404);
  const alias = db.doc('households/H-TEST2');
  await alias.set({ ...householdData, displayId: 'HH-0001', barangayId: 'barangay_borol' });
  assert.equal((await join('HH-0001'))[0], 409);
  assert.equal((await request.get()).exists, false);
  await alias.delete();

  const results = await Promise.all([join('HH-0001'), join('HH-00001'), join('H-TEST1')]);
  assert.deepEqual(results.map(([status]) => status).sort(), [201, 409, 409]);
  assert.deepEqual(results.find(([status]) => status === 201)[1], { data: { status: 'Pending' } });
  const submitted = (await request.get()).data();
  assert.deepEqual({ ...submitted, createdAt: null, updatedAt: null }, {
    householdId: 'H-TEST1', userId: uid, name: 'Applicant', relationship: 'Niece', status: 'Pending', revision: 1, createdAt: null, updatedAt: null,
  });
  assert.equal((await profile.get()).get('pendingHouseholdId'), 'H-TEST1');
  assert.equal((await profile.get()).get('householdId'), undefined);
  assert.deepEqual((await household.get()).data(), householdData);

  const rejection = db.batch();
  rejection.update(request, { status: 'Rejected', decidedBy: 'head' });
  rejection.update(profile, { pendingHouseholdId: null });
  await rejection.commit();
  assert.equal((await join('H-TEST1'))[0], 201);
  assert.equal((await db.collection('householdRequests').where('userId', '==', uid).get()).size, 1);
  assert.equal((await request.get()).get('decidedBy'), undefined);
});
