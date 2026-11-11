const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const enabled = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST);
if (!enabled) {
  test('resident authentication integration', { skip: 'Requires Firebase Auth and Firestore emulators' }, () => {});
} else {
  process.env.FIREBASE_PROJECT_ID = 'demo-ligtas-tests';
  const { auth, db } = require('../dist/config/firebaseAdmin');
  const router = require('../dist/routes/residentAuth').default;
  const barangayId = 'barangay_santol';
  const password = 'Test-password-123';
  const emulator = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`;
  let base;
  let server;

  before(async () => {
    await db.doc(`barangays/${barangayId}`).set({ name: 'Santol' });
    const app = express();
    app.use(express.json());
    app.use('/auth/resident', router);
    server = await new Promise(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    base = `http://127.0.0.1:${server.address().port}/auth/resident`;
  });
  after(async () => {
    server?.closeAllConnections();
    server?.close();
    await db.terminate();
  });

  async function post(path, data, endpoint = base) {
    const response = await fetch(`${endpoint}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  }
  const firebase = (method, data) => post(`accounts:${method}?key=demo-key`, data, `${emulator}/identitytoolkit.googleapis.com/v1`);
  const signup = input => post('register', { name: 'Resident QA', password, barangayId, ...input });
  async function phoneLogin(phone, uid) {
    const response = await post('login', { phone, password });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.cache, 'no-store');
    const { data } = response.body;
    assert.deepEqual(Object.keys(data), ['token']);
    const exchange = await firebase('signInWithCustomToken', { token: data.token, returnSecureToken: true });
    assert.equal(exchange.status, 200);
    assert.equal((await auth.verifyIdToken(exchange.body.idToken)).uid, uid);
  }

  test('phone-only registration, login, duplicate formats and invalid credentials', async () => {
    const created = await signup({ phone: '09123456781' });
    assert.equal(created.status, 201);
    const { uid } = created.body.data;
    const profile = (await db.doc(`users/${uid}`).get()).data();
    assert.equal(profile.phone, '9123456781');
    assert.equal(profile.email, '');
    assert.equal(profile.role, 'RESIDENT');
    assert.equal(Object.hasOwn(profile, 'password'), false);
    assert.equal((await auth.getUser(uid)).phoneNumber, undefined);
    for (const phone of ['639123456781', '+639123456781']) {
      assert.equal((await signup({ phone, email: 'duplicate@example.test' })).status, 409);
      await phoneLogin(phone, uid);
    }
    assert.equal((await signup({ phone: 'abc09123456781' })).status, 400);
    assert.equal((await post('login', { phone: '09123456781', password: 'Incorrect password' })).status, 401);
  });

  test('phone and email reach the same UID and concurrent signup reserves the number once', async () => {
    const results = await Promise.all([
      signup({ phone: '+639123456782', email: 'dual-one@example.test' }),
      signup({ phone: '09123456782', email: 'dual-two@example.test' }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const index = results.findIndex(result => result.status === 201);
    const { uid } = results[index].body.data;
    const email = ['dual-one@example.test', 'dual-two@example.test'][index];
    const direct = await firebase('signInWithPassword', { email, password, returnSecureToken: true });
    assert.equal(direct.status, 200);
    assert.equal(direct.body.localId, uid);
    await phoneLogin('9123456782', uid);
    await assert.rejects(auth.getUserByEmail(['dual-two@example.test', 'dual-one@example.test'][index]), { code: 'auth/user-not-found' });
  });

  test('legacy email and legacy phone credentials preserve their existing UIDs', async () => {
    const legacy = await auth.createUser({ email: 'legacy-resident@example.test', password });
    await db.doc(`users/${legacy.uid}`).set({ role: 'resident', phone: '09123456783', barangayId });
    await phoneLogin('+639123456783', legacy.uid);
    const direct = await firebase('signInWithPassword', { email: legacy.email, password, returnSecureToken: true });
    assert.equal(direct.body.localId, legacy.uid);
    assert.equal((await signup({ phone: '+639123456783' })).status, 409);

    const alias = await auth.createUser({ email: '9123456784@ligtas.local', password });
    await db.doc(`users/${alias.uid}`).set({ role: 'RESIDENT', barangayId });
    await phoneLogin('09123456784', alias.uid);
    assert.equal((await signup({ phone: '09123456784' })).status, 409);

    const older = await auth.createUser({ email: 'older-resident@example.test', password });
    await db.doc(`users/${older.uid}`).set({ role: 'RESIDENT', phoneNumber: '639123456786', barangayId });
    await phoneLogin('09123456786', older.uid);
    assert.equal((await signup({ phone: '09123456786' })).status, 409);
  });

  test('password setup after SMS proof links the original Firebase UID', async () => {
    const phoneNumber = '+639123456785';
    const existing = await auth.createUser({ phoneNumber });
    await db.doc(`users/${existing.uid}`).set({ role: 'RESIDENT', phone: phoneNumber, barangayId });
    assert.equal((await signup({ phone: phoneNumber })).status, 409);
    assert.equal((await post('login', { phone: phoneNumber, password })).status, 401);
    const challenge = await firebase('sendVerificationCode', { phoneNumber });
    assert.equal(challenge.status, 200);
    const codes = await fetch(`${emulator}/emulator/v1/projects/demo-ligtas-tests/verificationCodes`).then(res => res.json());
    const code = codes.verificationCodes.find(entry => entry.sessionInfo === challenge.body.sessionInfo).code;
    const proof = await firebase('signInWithPhoneNumber', { sessionInfo: challenge.body.sessionInfo, code });
    assert.equal(proof.body.localId, existing.uid);
    const linked = await firebase('signUp', { idToken: proof.body.idToken, email: '9123456785@ligtas.local', password, returnSecureToken: true });
    assert.equal(linked.body.localId, existing.uid);
    await phoneLogin(phoneNumber, existing.uid);
  });
}
