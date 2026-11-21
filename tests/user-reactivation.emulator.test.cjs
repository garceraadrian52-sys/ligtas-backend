const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const enabled = process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST;
if (!enabled) {
  test('account reactivation and login integration', { skip: 'Requires local Auth and Firestore emulators' }, () => {});
} else {
  for (const key of ['FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST']) assert.match(process.env[key], /^127\.0\.0\.1:\d+$/);
  assert.equal(process.env.FIREBASE_PROJECT_ID, 'demo-ligtas-tests');
  require('firebase-admin/app').initializeApp({ projectId: 'demo-ligtas-tests' });
  const { auth, db } = require('../dist/config/firebaseAdmin');
  const express = require('express');
  const httpFetch = global.fetch.bind(global);
  const prefix = 'reactivation-' + Date.now() + '-';
  const password = 'Emulator-only-password-123';
  const emulator = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST + '/identitytoolkit.googleapis.com/v1/';
  process.env.FIREBASE_WEB_API_KEY = 'demo-fixture-key';
  // Exercise the actual login router while preventing all production Identity Toolkit calls.
  global.fetch = (url, options) => {
    if (typeof url !== 'string') throw Error('Unexpected external request');
    if (url.startsWith('https://identitytoolkit.googleapis.com/v1/')) url = emulator + url.split('/v1/')[1];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//);
    return httpFetch(url, options);
  };
  const app = express(); app.use(express.json());
  app.use('/users', require('../dist/routes/users').default);
  app.use('/auth/resident', require('../dist/routes/residentAuth').default);
  app.use('/auth', require('../dist/routes/auth').default);
  let server, base, superToken;
  const uid = suffix => prefix + suffix;
  const credentials = suffix => ({ email: uid(suffix) + '@example.test', password });
  const post = async (path, body) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const status = (suffix, disabled, token = superToken, legacy = false) => fetch(base + '/users/' + uid(suffix) + (legacy ? '' : '/status'), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify({ disabled }),
  });
  before(async () => {
    for (const [suffix, role] of [['super', 'SUPER_ADMIN'], ['resident', 'RESIDENT'], ['official', 'BARANGAY_OFFICIAL'], ['staff', 'LGU_ADMIN']]) {
      await auth.createUser({ uid: uid(suffix), ...credentials(suffix), displayName: 'Existing ' + suffix });
      await db.doc('users/' + uid(suffix)).set({ name: 'Existing ' + suffix, email: credentials(suffix).email, role, disabled: false,
        ...(role === 'RESIDENT' || role === 'BARANGAY_OFFICIAL' ? { barangayId: 'barangay_santol' } : {}),
        ...(role === 'RESIDENT' ? { householdId: uid('household'), phone: '9123456777' } : {}),
        displayId: 'ACC-00003', createdAt: new Date('2026-01-01T00:00:00Z'), preferences: { language: 'filipino' } });
    }
    await db.doc('barangays/barangay_santol').set({ name: 'Santol' });
    for (const collection of ['households', 'reports', 'evacuationRecords']) await db.doc(collection + '/' + uid('linked')).set({ userId: uid('resident'), original: true });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = 'http://127.0.0.1:' + server.address().port;
    const login = await post('/auth/login', credentials('super')); assert.equal(login.status, 200, JSON.stringify(login.body));
    superToken = login.body.data.token;
  });
  after(async () => { server?.closeAllConnections(); server?.close(); global.fetch = httpFetch; await db.terminate(); });

  for (const [suffix, loginPath] of [['resident', '/auth/mobile-login'], ['official', '/auth/mobile-login'], ['staff', '/auth/login']]) {
    test(suffix + ' cannot log in while disabled, then signs in with the same password and UID after reactivation', async () => {
      const ref = db.doc('users/' + uid(suffix));
      const original = (await ref.get()).data();
      assert.equal((await status(suffix, true)).status, 200);
      assert.equal((await auth.getUser(uid(suffix))).disabled, true);
      assert.equal((await ref.get()).data().disabled, true);
      assert.equal((await post(loginPath, credentials(suffix))).status, 401);
      assert.equal((await status(suffix, false)).status, 200);
      assert.equal((await auth.getUser(uid(suffix))).disabled, false);
      const profile = (await ref.get()).data(); delete profile.updatedAt;
      assert.deepEqual(profile, original);
      const login = await post(loginPath, credentials(suffix)); assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(login.body.data.user.id, uid(suffix)); assert.equal(login.body.data.user.role, original.role);
      const events = (await db.collection('auditLogs').where('targetId', '==', uid(suffix)).get()).docs.map(doc => doc.data());
      assert.ok(events.some(event => event.action === 'user_deactivated'));
      assert.ok(events.some(event => event.action === 'user_activated' && event.actorId === uid('super') && event.details.disabled === false));
    });
  }
  test('resident mobile-number login is restored without replacing the account or linked records', async () => {
    assert.equal((await status('resident', true)).status, 200);
    assert.equal((await post('/auth/resident/login', { phone: '09123456777', password })).status, 401);
    assert.equal((await status('resident', false)).status, 200);
    const login = await post('/auth/resident/login', { phone: '+639123456777', password });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const exchange = await fetch(emulator + 'accounts:signInWithCustomToken?key=demo-fixture-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: login.body.data.token, returnSecureToken: true }) });
    const identity = await exchange.json(); assert.equal(exchange.status, 200);
    assert.equal((await auth.verifyIdToken(identity.idToken)).uid, uid('resident'));
    for (const collection of ['households', 'reports', 'evacuationRecords']) assert.deepEqual((await db.doc(collection + '/' + uid('linked')).get()).data(), { userId: uid('resident'), original: true });
  });
  test('real middleware rejects missing credentials, LGU reactivation and a disabled caller with an old token', async () => {
    assert.equal((await status('resident', false, '')).status, 401);
    const staff = await post('/auth/login', credentials('staff')); assert.equal(staff.status, 200);
    assert.equal((await status('resident', false, staff.body.data.token)).status, 403);
    await db.doc('users/' + uid('staff')).update({ disabled: true });
    assert.equal((await status('resident', true, staff.body.data.token)).status, 403);
    await auth.updateUser(uid('staff'), { disabled: true });
    // Firebase may reject this token before the profile guard; neither path grants access.
    const denied = await status('resident', true, staff.body.data.token);
    assert.ok([401,403].includes(denied.status));
  });
  test('legacy staff edit endpoint also synchronizes both statuses and records reactivation', async () => {
    assert.equal((await status('official', true)).status, 200);
    assert.equal((await status('official', false, superToken, true)).status, 200);
    assert.equal((await auth.getUser(uid('official'))).disabled, false);
    assert.equal((await db.doc('users/' + uid('official')).get()).data().barangayId, 'barangay_santol');
    assert.equal((await post('/auth/mobile-login', credentials('official'))).status, 200);
  });
}
