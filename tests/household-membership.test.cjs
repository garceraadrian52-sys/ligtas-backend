const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const enabled = process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST;
if (!enabled) {
  test('household membership transactions', { skip: 'Requires isolated Auth and Firestore emulators' }, () => {});
} else {
  // This suite refuses non-local emulator targets and never loads production credentials.
  for (const host of [process.env.FIREBASE_AUTH_EMULATOR_HOST, process.env.FIRESTORE_EMULATOR_HOST]) {
    assert.match(host, /^(127\.0\.0\.1|localhost):\d+$/);
  }
  process.env.FIREBASE_PROJECT_ID = 'demo-ligtas-tests';
  const { initializeApp } = require('firebase-admin/app');
  initializeApp({ projectId: 'demo-ligtas-tests' });
  const { db } = require('../dist/config/firebaseAdmin');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/households', require('../dist/routes/households').default);
  app.use(require('../dist/middleware/errorHandler').notFound);
  let server, base, count = 0;
  const run = Date.now().toString();
  before(async () => {
    await db.doc('recordIdCounters/households').set({ lastIssued: Number(run) });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}/households`;
  });
  after(async () => { server.closeAllConnections(); server.close(); await db.terminate(); });

  async function account(name = 'Registered Maria', role = 'RESIDENT', barangayId = 'barangay_borol') {
    const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
    });
    assert.equal(response.status, 200);
    const { localId: uid, idToken: token } = await response.json();
    await db.doc(`users/${uid}`).set({ name, role, barangayId, preferences: { language: 'Filipino' }, reportIds: ['previous-report'] });
    return { uid, token };
  }
  async function call(path, body, actor, method = 'POST') {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json',
      ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  async function fixture() {
    const n = ++count, id = `H-B18TEST${run}-${n}`;
    const head = await account('Head', 'resident', 'barangay_wawa');
    const members = [
      { id: 'head', name: 'Head', relationship: 'Head of Household', userId: head.uid },
      { id: 'original-maria', name: 'Maria', relationship: 'Wife', evacuationPersonKey: 'keep-original-history', age: 35 },
      { id: 'same-name', name: 'Maria', relationship: 'Cousin' },
      { id: 'child', name: 'Child', relationship: 'Daughter' },
    ];
    const ref = db.doc(`households/${id}`);
    const data = { name: 'Home', street: 'Private street', contact: '9123456789', head: 'Head', barangayId: 'barangay_wawa',
      createdBy: head.uid, displayId: `HH-${run}${n}`, members, memberUids: [head.uid], originalField: 'preserve' };
    await ref.set(data);
    await db.doc(`users/${head.uid}`).update({ householdId: id, householdMemberId: 'head' });
    const history = db.doc(`evacuationRecords/b18-history-${run}-${n}`);
    await history.set({ householdId: id, memberIds: ['original-maria', 'child'], memberNames: ['Maria', 'Child'], status: 'checked_out', recordedAt: new Date('2026-11-01') });
    // The manually listed person registers later. No name-based linking occurs.
    const applicant = await account();
    const outsider = await account('Outsider');
    const beforeHistory = (await history.get()).data();
    return { id, head, applicant, outsider, ref, data, members, history, beforeHistory,
      requestId: `${id}_${applicant.uid}`,
      join: selection => call('/join', { reference: id, ...selection }, applicant),
      decide: (approve = true, identityConfirmed = true, actor = head) => call(`/requests/${id}_${applicant.uid}/decision`, { approve, identityConfirmed }, actor) };
  }
  async function edit(f, members, actor = f.head, expected = f.data) {
    return call(`/${f.id}/details`, { name: 'Home', street: 'Updated street', contact: '09123456789', members,
      expectedMembers: expected.members, expectedDetails: { name: expected.name, street: expected.street, contact: expected.contact } }, actor, 'PATCH');
  }

  test('QR and ID previews work across barangays and expose only membership selection information', async () => {
    const f = await fixture();
    assert.equal((await f.ref.get()).get('members')[1].userId, undefined);
    for (const reference of [f.id, f.data.displayId, JSON.stringify({ app: 'ligtas', version: 1, householdId: f.id })]) {
      const response = await call('/preview', { reference }, f.applicant);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.cache, 'no-store');
      assert.deepEqual(Object.keys(response.body.data).sort(), ['displayId', 'head', 'id', 'members', 'name']);
      assert.deepEqual(response.body.data.members[1], { id: 'original-maria', name: 'Maria', relationship: 'Wife', linked: false });
      assert.equal(response.body.data.members[0].linked, true);
      assert.equal(JSON.stringify(response.body).includes('Private street'), false);
      assert.equal(JSON.stringify(response.body).includes(f.head.uid), false);
    }
    assert.equal((await call('/preview', { reference: '../users/head' }, f.applicant)).status, 400);
    assert.equal((await call('/preview', { reference: JSON.stringify({ app: 'other', version: 1, householdId: f.id }) }, f.applicant)).status, 400);
    assert.equal((await call('/preview', { reference: 'HH-99999' }, f.applicant)).status, 404);
    const official = await account('Official', 'BARANGAY_OFFICIAL');
    assert.equal((await call('/preview', { reference: f.id }, official)).status, 403);
  });

  test('selected manual member is linked atomically on identity-confirmed head approval, preserving IDs and history', async () => {
    const f = await fixture();
    const active = db.doc(`activeEvacuations/${f.id}`);
    const activeData = { householdId: f.id, memberIds: ['original-maria'], lastAttendanceId: f.history.id };
    await active.set(activeData);
    const beforeProfile = (await db.doc(`users/${f.applicant.uid}`).get()).data();
    assert.equal((await f.join({ memberId: 'original-maria', userId: f.outsider.uid, status: 'Approved' })).status, 201);
    assert.deepEqual((await f.ref.get()).get('members'), f.members);
    const request = (await db.doc(`householdRequests/${f.requestId}`).get()).data();
    assert.equal(request.status, 'Pending'); assert.equal(request.userId, f.applicant.uid);
    assert.equal(request.memberId, 'original-maria'); assert.equal(request.relationship, 'Wife');
    assert.equal((await f.decide(true, false)).status, 400);
    assert.equal((await f.decide(true, true, f.outsider)).status, 403);
    const approvals = await Promise.all([f.decide(), f.decide(), f.decide()]);
    assert.ok(approvals.every(r => r.status === 200), JSON.stringify(approvals));
    const updated = (await f.ref.get()).data();
    assert.equal(updated.members.length, f.members.length);
    assert.deepEqual(updated.members[1], { ...f.members[1], userId: f.applicant.uid });
    assert.deepEqual(updated.members[2], f.members[2]); // Same name never selects or links another row.
    assert.deepEqual(updated.memberUids, [f.head.uid, f.applicant.uid]);
    const profile = (await db.doc(`users/${f.applicant.uid}`).get()).data();
    assert.equal(profile.householdId, f.id); assert.equal(profile.householdMemberId, 'original-maria');
    assert.equal(profile.pendingHouseholdId, null);
    assert.deepEqual(profile.preferences, beforeProfile.preferences); assert.deepEqual(profile.reportIds, beforeProfile.reportIds);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
    assert.deepEqual((await active.get()).data(), activeData);
    assert.equal((await db.collection('householdRequests').where('userId', '==', f.applicant.uid).get()).size, 1);
    const preview = await call('/preview', { reference: f.id }, f.outsider);
    assert.equal(preview.body.data.members[1].linked, true);
  });

  test('duplicate and concurrent join requests create one request and never associate an account before approval', async () => {
    const f = await fixture();
    const results = await Promise.all([f.join({ memberId: 'original-maria' }), f.join({ memberId: 'original-maria' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.deepEqual((await f.ref.get()).get('members'), f.members);
    assert.equal((await db.doc(`users/${f.applicant.uid}`).get()).get('householdId'), undefined);
    assert.equal((await db.collection('householdRequests').where('userId', '==', f.applicant.uid).get()).size, 1);
  });

  test('two accounts claiming the same member cannot both be approved', async () => {
    const f = await fixture();
    assert.equal((await f.join({ memberId: 'original-maria' })).status, 201);
    assert.equal((await call('/join', { reference: f.id, memberId: 'original-maria' }, f.outsider)).status, 201);
    const results = await Promise.all([f.decide(), call(`/requests/${f.id}_${f.outsider.uid}/decision`, { approve: true, identityConfirmed: true }, f.head)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const updated = (await f.ref.get()).data();
    assert.equal(updated.members.length, f.members.length);
    assert.equal(updated.memberUids.length, 2);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
  });

  test('manual edits/additions/removal preserve original fields, retire removed IDs and leave evacuation records unchanged', async () => {
    const f = await fixture();
    const next = f.members.filter(m => m.id !== 'child').map(m => m.id === 'original-maria' ? { ...m, name: 'Maria Updated' } : m);
    next.push({ id: 'new-person', name: 'Another member', relationship: 'Son' });
    assert.equal((await edit(f, next)).status, 200);
    const updated = (await f.ref.get()).data();
    assert.equal(updated.originalField, 'preserve'); assert.equal(updated.displayId, f.data.displayId);
    assert.equal(updated.members[1].id, 'original-maria'); assert.equal(updated.members[1].age, 35);
    assert.equal(updated.members[1].evacuationPersonKey, 'keep-original-history');
    assert.equal(updated.retiredMembers[0].id, 'child'); assert.equal(updated.retiredMembers[0].name, 'Child');
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
    assert.equal((await edit(f, [...updated.members, { id: 'child', name: 'Different person', relationship: 'Son' }], f.head, updated)).status, 409);
    assert.equal((await edit(f, next)).status, 409); // Stale editor cannot overwrite newer data.
  });

  test('member management rejects unauthorized edits, forged links, registered changes and duplicate IDs', async () => {
    const f = await fixture();
    assert.equal((await edit(f, f.members, f.outsider)).status, 403);
    assert.equal((await edit(f, f.members.filter(m => m.id !== 'head'))).status, 403);
    assert.equal((await edit(f, f.members.map(m => m.id === 'head' ? { ...m, userId: f.outsider.uid } : m))).status, 403);
    assert.equal((await edit(f, [...f.members, { id: 'forged', name: 'Other', relationship: 'Son', userId: f.outsider.uid }])).status, 403);
    assert.equal((await edit(f, [...f.members, f.members[1]])).status, 400);
    assert.equal((await f.join({ memberId: 'head' })).status, 409);
    assert.equal((await f.join({ memberId: 'not-listed' })).status, 409);
    await f.join({ memberId: 'original-maria' }); await f.decide();
    const updated = (await f.ref.get()).data();
    assert.equal((await edit(f, updated.members.filter(m => m.id !== 'original-maria'), f.head, updated)).status, 403);
    assert.equal((await edit(f, updated.members.map(m => m.id === 'original-maria' ? { ...m, name: 'Reassigned' } : m), f.head, updated)).status, 403);
  });

  test('pending selected identities and active evacuees cannot be removed during review/check-in', async () => {
    const f = await fixture();
    await f.join({ memberId: 'original-maria' });
    assert.equal((await edit(f, f.members.filter(m => m.id !== 'original-maria'))).status, 409);
    assert.equal((await edit(f, f.members.map(m => m.id === 'original-maria' ? { ...m, name: 'Changed identity' } : m))).status, 409);
    assert.equal((await f.decide(false)).status, 200);
    assert.equal((await f.decide(false)).status, 200);
    assert.equal((await db.doc(`users/${f.applicant.uid}`).get()).get('pendingHouseholdId'), null);
    await db.doc(`activeEvacuations/${f.id}`).set({ householdId: f.id, memberIds: ['child'] });
    assert.equal((await edit(f, f.members.filter(m => m.id !== 'child'))).status, 409);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
    assert.deepEqual((await f.ref.get()).get('members'), f.members);
    assert.equal((await f.join({ memberId: 'original-maria' })).status, 201); // Reapply after rejection.
  });

  test('approval revalidates disabled accounts, membership moves and selected-member identity changes', async () => {
    const f = await fixture();
    await f.join({ memberId: 'original-maria' });
    await db.doc(`users/${f.applicant.uid}`).update({ disabled: true });
    assert.equal((await f.decide()).status, 403);
    await db.doc(`users/${f.applicant.uid}`).update({ disabled: false, householdId: 'H-OTHER' });
    assert.equal((await f.decide()).status, 409);
    await db.doc(`users/${f.applicant.uid}`).update({ householdId: null });
    await f.ref.update({ members: f.members.map(m => m.id === 'original-maria' ? { ...m, name: 'Changed out of band' } : m) });
    assert.equal((await f.decide()).status, 409);
    assert.equal((await db.doc(`householdRequests/${f.requestId}`).get()).get('status'), 'Pending');
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
  });

  test('legacy relationship-only join and household creation/reference routes remain compatible', async () => {
    const f = await fixture();
    assert.equal((await f.join({ relationship: 'Niece' })).status, 201);
    assert.equal((await f.decide(true, false)).status, 200);
    const after = (await f.ref.get()).data();
    assert.equal(after.members.length, f.members.length + 1);
    assert.equal(after.members.at(-1).userId, f.applicant.uid);
    const fresh = await account('New Head');
    const created = await call('', { name: 'New Home', street: 'Street', contact: '+639123456789', barangay: 'Borol',
      members: [{ id: 'head', name: 'Do not trust this name', relationship: 'Head' }, { id: 'manual', name: 'Later applicant', relationship: 'Child' }] }, fresh);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.data.displayId, /^HH-\d{5,}$/);
    assert.equal(created.body.data.members[0].name, 'New Head');
    assert.equal(created.body.data.members[0].userId, fresh.uid);
    const reference = await call(`/${created.body.data.id}/reference`, {}, fresh);
    assert.equal(reference.status, 200); assert.equal(reference.body.data.displayId, created.body.data.displayId);
    assert.equal((await call(`/${created.body.data.id}/reference`, {}, f.outsider)).status, 403);
    assert.equal((await call('', { ...created.body.data }, fresh)).status, 409);
  });

  test('reference allocation refuses a stale counter without changing existing IDs or household data', async () => {
    const head = await account('Counter test head');
    const counter = db.doc('recordIdCounters/households');
    const before = (await counter.get()).data();
    try {
      await counter.set({ lastIssued: 900 });
      const existing = db.doc(`households/H-B18COUNTER${run}`);
      await existing.set({ displayId: 'HH-00901', createdBy: 'original-head', members: [] });
      const response = await call('', { name: 'Home', street: 'Street', contact: '09123456789',
        members: [{ id: 'head', name: 'Head', relationship: 'Head' }] }, head);
      assert.equal(response.status, 409);
      assert.equal((await counter.get()).get('lastIssued'), 900);
      assert.equal((await existing.get()).get('displayId'), 'HH-00901');
      assert.equal((await db.doc(`users/${head.uid}`).get()).get('householdId'), undefined);
    } finally { await counter.set(before); }
  });

  test('an old head confirmation cannot decide a rejected and resubmitted request for a different member', async () => {
    const f = await fixture();
    await f.join({ memberId: 'original-maria' });
    await f.decide(false);
    await f.join({ memberId: 'same-name' });
    const stale = await call(`/requests/${f.requestId}/decision`, { approve: true, identityConfirmed: true, expectedRevision: 1 }, f.head);
    assert.equal(stale.status, 409);
    assert.equal((await f.decide()).status, 409); // Old Build 18 must not silently approve a resubmission.
    assert.deepEqual((await f.ref.get()).get('members'), f.members);
    const approved = await call(`/requests/${f.requestId}/decision`, { approve: true, identityConfirmed: true, expectedRevision: 2 }, f.head);
    assert.equal(approved.status, 200);
    const members = (await f.ref.get()).get('members');
    assert.deepEqual(members[1], f.members[1]);
    assert.equal(members[2].id, 'same-name'); assert.equal(members[2].userId, f.applicant.uid);
    assert.equal(members.length, f.members.length);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
  });

  test('cross-barangay preview never exposes account UIDs used as legacy registered member IDs', async () => {
    const f = await fixture();
    const registered = await account('Legacy registered');
    const member = { id: registered.uid, name: 'Legacy registered', relationship: 'Son' };
    await f.ref.update({ members: [...f.members, member], memberUids: [f.head.uid, registered.uid] });
    const response = await call('/preview', { reference: f.id }, f.applicant);
    assert.equal(response.status, 200);
    const legacy = response.body.data.members.find(m => m.name === member.name);
    assert.equal(legacy.linked, true);
    assert.notEqual(legacy.id, registered.uid);
    assert.equal(JSON.stringify(response.body).includes(registered.uid), false);
    assert.equal(response.body.data.members[1].id, 'original-maria');
    assert.equal((await f.ref.get()).get('members').at(-1).id, registered.uid);
  });

  test('member edits do not read historical membership decisions or normalize unchanged member data', async () => {
    const f = await fixture();
    f.members[1] = { ...f.members[1], name: ' Maria ', relationship: ' Wife ' };
    await f.ref.update({ members: f.members });
    const batch = db.batch();
    for (let i = 0; i < 100; i++) batch.set(db.doc(`householdRequests/${f.id}_history_${i}`), {
      householdId: f.id, userId: 'previous-account', memberId: 'same-name', status: i % 2 ? 'Approved' : 'Rejected',
    });
    await batch.commit();
    let reads = 0;
    const trackedDb = new Proxy(db, { get(target, field) {
      if (field === 'runTransaction') return callback => target.runTransaction(tx => callback(new Proxy(tx, {
        get(transaction, operation) {
          if (operation === 'get') return async (...args) => {
            const snapshot = await transaction.get(...args);
            reads += Array.isArray(snapshot.docs) ? snapshot.docs.length : 1;
            return snapshot;
          };
          const value = Reflect.get(transaction, operation, transaction);
          return typeof value === 'function' ? value.bind(transaction) : value;
        },
      })));
      const value = Reflect.get(target, field, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const result = await require('../dist/services/householdMembership').saveHouseholdMembers(trackedDb, f.head.uid, f.id, {
      name: f.data.name, street: f.data.street, contact: f.data.contact,
      members: f.members.map(m => m.id === 'child' ? { ...m, name: 'Child updated' } : m), expectedMembers: f.members,
      expectedDetails: { name: f.data.name, street: f.data.street, contact: f.data.contact },
    });
    assert.equal(result.saved, true);
    assert.ok(reads <= 5, `Member edit read ${reads} documents despite no pending requests.`);
    assert.deepEqual((await f.ref.get()).get('members')[1], f.members[1]);
    assert.equal((await db.collection('householdRequests').where('householdId', '==', f.id).get()).size, 100);
  });

  test('household ID lookup supports authorized evacuation staff, legacy display IDs, and resident area privacy', async () => {
    const f = await fixture();
    let shortId, canonical;
    do {
      shortId = `HH-${Math.floor(Math.random() * 9000) + 1000}`;
      canonical = `HH-0${shortId.slice(3)}`;
    } while (!(await db.collection('households').where('displayId', 'in', [shortId, canonical]).limit(1).get()).empty);
    await f.ref.update({ displayId: shortId });
    const official = await account('Local official', 'BARANGAY_OFFICIAL', 'barangay_wawa');
    const outside = await account('Outside official', 'BARANGAY_OFFICIAL', 'barangay_borol');
    const admin = await account('Municipal admin', 'LGU_ADMIN', null);
    for (const actor of [f.head, official, admin]) {
      for (const displayId of [canonical, shortId.toLowerCase()]) {
        const response = await call('/resolve', { displayId }, actor);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.body.data.id, f.id);
      }
    }
    assert.equal((await call('/resolve', { displayId: canonical }, f.applicant)).status, 404);
    assert.equal((await call('/resolve', { displayId: canonical }, outside)).status, 404);
    assert.equal((await f.ref.get()).get('displayId'), shortId);
    const duplicate = db.doc(`households/${f.id}-DUP`);
    await duplicate.set({ ...f.data, displayId: canonical, barangayId: 'barangay_borol' });
    assert.equal((await call('/resolve', { displayId: canonical }, admin)).status, 409);
    assert.equal((await call('/resolve', { displayId: canonical }, official)).status, 200);
  });
  test('legacy random request IDs link the original member and clear both pending pointers', async () => {
    const f = await fixture();
    const requestId = `legacy-${f.applicant.uid}`;
    await db.doc(`householdRequests/${requestId}`).set({ householdId: f.id, userId: f.applicant.uid,
      memberId: 'original-maria', selectedMemberName: 'Maria', relationship: 'Wife', status: 'Pending', requestVersion: requestId });
    await db.doc(`users/${f.applicant.uid}`).update({ pendingHouseholdId: f.id, pendingHouseholdRequestId: requestId });
    const response = await call(`/requests/${requestId}/decision`, { approve: true, identityConfirmed: true }, f.head);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await f.ref.get()).get('members')[1].id, 'original-maria');
    assert.equal((await f.ref.get()).get('members')[1].userId, f.applicant.uid);
    assert.equal((await db.doc(`users/${f.applicant.uid}`).get()).get('pendingHouseholdRequestId'), null);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
  });

  test('legacy links and orphan requests block duplicate household membership without rewriting history', async () => {
    const f = await fixture();
    const legacy = db.doc(`households/H-LEGACY-${f.applicant.uid.toUpperCase()}`);
    await legacy.set({ createdBy: 'legacy-head', memberUids: [f.applicant.uid] });
    assert.equal((await f.join({ memberId: 'original-maria' })).status, 409);
    await legacy.delete();
    const orphan = db.doc(`householdRequests/orphan-${f.applicant.uid}`);
    await orphan.set({ userId: f.applicant.uid, householdId: 'H-ANOTHER', status: 'Pending' });
    assert.equal((await f.join({ memberId: 'original-maria' })).status, 409);
    assert.equal((await f.ref.get()).get('members')[1].userId, undefined);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
  });

  test('rejecting an older request cannot clear a newer pending request pointer', async () => {
    const f = await fixture();
    assert.equal((await f.join({ memberId: 'original-maria' })).status, 201);
    const newer = `newer-${f.applicant.uid}`;
    await db.doc(`householdRequests/${newer}`).set({ userId: f.applicant.uid, householdId: f.id, status: 'Pending' });
    await db.doc(`users/${f.applicant.uid}`).update({ pendingHouseholdRequestId: newer });
    assert.equal((await f.decide(false)).status, 200);
    assert.equal((await db.doc(`users/${f.applicant.uid}`).get()).get('pendingHouseholdRequestId'), newer);
    assert.equal((await db.doc(`users/${f.applicant.uid}`).get()).get('pendingHouseholdId'), f.id);
  });

  test('approved legacy add-new requests with null memberId retry without duplicating a member', async () => {
    const f = await fixture();
    assert.equal((await f.join({ relationship: 'Friend' })).status, 201);
    assert.equal((await f.decide(true)).status, 200);
    await db.doc(`householdRequests/${f.requestId}`).update({ memberId: null });
    const before = (await f.ref.get()).data();
    assert.equal((await f.decide(true)).status, 200);
    assert.deepEqual((await f.ref.get()).data(), before);
    assert.deepEqual((await f.history.get()).data(), f.beforeHistory);
    await db.doc(`users/${f.applicant.uid}`).update({ householdMemberId: 'different-person' });
    assert.equal((await f.decide(true)).status, 409);
  });
}
