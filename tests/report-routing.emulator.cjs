const assert = require('node:assert/strict');
const { test, beforeEach, after } = require('node:test');
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const path = require('node:path');
const mobile = path.resolve(__dirname, '../../ligtas-mobile');
const { initializeTestEnvironment, assertFails } = require(path.join(mobile, 'node_modules/@firebase/rules-unit-testing'));
const { doc, collection, query, where, getDocs, getDoc, setDoc, updateDoc, writeBatch, serverTimestamp } = require(path.join(mobile, 'node_modules/firebase/firestore'));
const { submitLocatedReport } = require('../dist/services/reportSubmission');
const { reroutePendingReport } = require('../dist/services/reportRerouting');
const host = process.env.FIRESTORE_EMULATOR_HOST;
if (!host || !/^(localhost|127\.0\.0\.1):[0-9]+$/.test(host)) throw Error('Run only with a local Firestore emulator.');
const projectId = 'demo-ligtas-tests';
const app = initializeApp({ projectId }, 'report-routing-tests'); const db = getFirestore(app);
let env;
beforeEach(async () => {
  if (env) await env.cleanup();
  assert.equal((await fetch('http://' + host + '/emulator/v1/projects/' + projectId + '/databases/(default)/documents', { method: 'DELETE' })).ok, true);
  const [hostname, port] = host.split(':');
  env = await initializeTestEnvironment({ projectId, firestore: { host: hostname, port: Number(port) } });
  await Promise.all([
    db.doc('users/resident').set({ role: 'RESIDENT', name: 'Resident', barangayId: 'barangay_borol_1st' }),
    db.doc('users/wawa').set({ role: 'BARANGAY_OFFICIAL', name: 'Wawa official', barangayId: 'barangay_wawa' }),
    db.doc('users/borol').set({ role: 'BARANGAY_OFFICIAL', name: 'Borol official', barangayId: 'barangay_borol_1st' }),
    db.doc('barangays/barangay_wawa').set({ name: 'Wawa' }),
  ]);
});
after(async () => { await env?.cleanup(); await db.terminate(); await deleteApp(app); });
const input = { id: 'mobile-job', ownerId: 'resident', type: 'road', latitude: 14.81329798, longitude: 120.90529689, location: 'Road in Wawa', description: 'Flooding', roadStatus: 'PASSABLE', floodingLevel: 'Gutter Level', cause: 'Flooding' };

test('real routing puts a Borol resident report in Wawa verification and denies client routing bypasses', async () => {
  const results = await Promise.all([submitLocatedReport(db, 'resident', input), submitLocatedReport(db, 'resident', input)]);
  assert.equal(results.filter(r => !r.duplicate).length, 1);
  const resident = env.authenticatedContext('resident').firestore(), wawa = env.authenticatedContext('wawa').firestore(), borol = env.authenticatedContext('borol').firestore();
  assert.equal((await getDocs(query(collection(wawa, 'reports'), where('barangayId','==','barangay_wawa')))).size, 1);
  assert.equal((await getDocs(query(collection(borol, 'reports'), where('barangayId','==','barangay_borol_1st')))).size, 0);
  await assertFails(getDoc(doc(borol, 'reports/mobile-job')));
  await assertFails(updateDoc(doc(borol, 'reports/mobile-job'), { status: 'Verified', verification: 'Verified', reviewedBy: 'borol' }));
  await assertFails(updateDoc(doc(resident, 'reports/mobile-job'), { barangayId: 'barangay_borol_1st' }));
  await assertFails(updateDoc(doc(wawa, 'reports/mobile-job'), { latitude: 14.8 }));
  await assertFails(setDoc(doc(resident, 'reports/client-forgery'), { ...input, reporterId: 'resident', barangayId: 'barangay_wawa', routingVersion: 1, verification: 'Pending' }));
  await assertFails(setDoc(doc(wawa, 'reports/official-forgery'), { ...input, reporterId: 'wawa', barangayId: 'barangay_wawa', routingVersion: 1, status: 'Verified', verification: 'Verified' }));
  for (const extra of [{ verifiedBy: 'another-user' }, { verifiedAt: new Date('2099-01-01T00:00:00Z') }, { reviewedAt: new Date('2000-01-01T00:00:00Z') }]) {
    const forged = writeBatch(wawa);
    forged.update(doc(wawa, 'reports/mobile-job'), { status: 'Verified', verification: 'Verified', reviewedBy: 'wawa', ...extra });
    forged.update(doc(wawa, 'roadConditions/mobile-job'), { reportStatus: 'Verified', verification: 'Verified', reviewedBy: 'wawa', ...extra });
    await assertFails(forged.commit());
  }
  const batch = writeBatch(wawa);
  const review = { verification: 'Verified', reviewedBy: 'wawa', verifiedBy: 'wawa', reviewedAt: serverTimestamp(), verifiedAt: serverTimestamp(), updatedAt: serverTimestamp() };
  batch.update(doc(wawa, 'reports/mobile-job'), { ...review, status: 'Verified' });
  batch.update(doc(wawa, 'roadConditions/mobile-job'), { ...review, reportStatus: 'Verified' });
  await batch.commit();
  assert.equal((await getDoc(doc(resident, 'reports/mobile-job'))).get('verification'), 'Verified');
  assert.equal((await getDoc(doc(borol, 'roadConditions/mobile-job'))).get('verification'), 'Verified');
  assert.equal((await db.doc('users/resident').get()).get('barangayId'), 'barangay_borol_1st');
  assert.equal((await db.doc('recordIdCounters/reports').get()).get('lastIssued'), 1);
});
test('pending migration moves the original report and mirror without touching verification history', async () => {
  const old = { reporterId: 'resident', status: 'Pending', verification: 'Pending', barangayId: 'barangay_borol_1st', latitude: input.latitude, longitude: input.longitude, roadConditionId: 'old', type: 'road', location: 'Original address', description: 'Original description', createdAt: new Date('2026-11-01T00:00:00Z') };
  await db.doc('reports/old').set(old); await db.doc('roadConditions/old').set({ ...old, reportStatus: 'Pending' });
  await db.doc('reports/reviewed').set({ ...old, status: 'Verified', verification: 'Verified' });
  const original = (await db.doc('reports/old').get()).data();
  assert.equal((await reroutePendingReport(db, 'old')).status, 'would-update');
  assert.equal((await db.doc('reports/old').get()).get('barangayId'), 'barangay_borol_1st');
  await reroutePendingReport(db, 'old', true);
  const changed = (await db.doc('reports/old').get()).data();
  assert.equal(changed.barangayId, 'barangay_wawa'); assert.equal(changed.description, original.description); assert.deepEqual(changed.createdAt, original.createdAt);
  assert.equal((await db.doc('roadConditions/old').get()).get('barangayId'), 'barangay_wawa');
  assert.equal((await reroutePendingReport(db, 'reviewed', true)).status, 'skipped');
});
