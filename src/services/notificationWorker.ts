import { createHash } from 'node:crypto';
import { Timestamp, FieldValue, type DocumentReference } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { published, inArea, kindForAlert, enabled, retryDelay, alertRevision } from './notificationPolicy';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = () => Timestamp.now();
const later = (ms: number) => Timestamp.fromMillis(Date.now() + ms);
const deliveries = db.collection('notificationDeliveries');

async function queueForUser(uid: string, payload: any, revision: string) {
  const profileSnap = await db.doc(`users/${uid}`).get();
  const profile = profileSnap.data();
  if (!profile || !enabled(profile, payload.kind)) {
    console.log(`Skipping user ${uid}: profile=${!!profile}, enabled=${profile ? enabled(profile, payload.kind) : 'n/a'}`);
    return;
  }

  const devices = await db.collection(`users/${uid}/devices`).where('enabled', '==', true).get();
  console.log(`User ${uid}: found ${devices.size} enabled device(s)`);

  for (const device of devices.docs) {
    const id = hash(`${revision}:${device.ref.path}`);
    try {
      await deliveries.doc(id).create({
        ...payload, userId: uid, devicePath: device.ref.path,
        state: 'pending', attempts: 0, nextAttemptAt: now(), createdAt: now(), expiresAt: later(24 * 3600000),
      });
      console.log(`Queued delivery ${id} for user ${uid}`);
    } catch (error: any) {
      if (error.code !== 6 && error.code !== 'already-exists') throw error;
      console.log(`Delivery ${id} already exists, skipping.`);
    }
  }
}

// --- Watchers (kapalit ng onDocumentWritten Cloud Function triggers) ---

const alertCache = new Map<string, any>();
let alertsReady = false;

function startAlertWatcher() {
  db.collection('alerts').onSnapshot(async (snapshot) => {
    if (!alertsReady) {
      snapshot.docs.forEach((doc) => alertCache.set(doc.id, doc.data()));
      alertsReady = true;
      console.log(`Alert watcher ready. Cached ${snapshot.size} existing alert(s).`);
      return; // skip existing docs sa unang load, para walang notification spam pag-start
    }

    console.log(`Alert watcher detected ${snapshot.docChanges().length} change(s).`);

    for (const change of snapshot.docChanges()) {
      if (change.type === 'removed') { alertCache.delete(change.doc.id); continue; }
      const alert = change.doc.data();
      alertCache.set(change.doc.id, alert);

      console.log(`Alert change [${change.type}] id=${change.doc.id} status=${alert.status}`);

      if (!published(alert)) {
        console.log(`Alert ${change.doc.id} not published (status=${alert.status}), skipping.`);
        continue;
      }
      console.log(`Processing published alert: ${change.doc.id}`);

      const kind = kindForAlert(alert);
      const revision = alertRevision(change.doc.id, alert);
      let cursor;
      let usersChecked = 0;
      while (true) {
        let query: FirebaseFirestore.Query = db.collection('users').orderBy('__name__').limit(200);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        for (const user of page.docs) {
          usersChecked++;
          const userData = user.data();
          const matches = inArea(alert, userData);
          console.log(`  User ${user.id} (role=${userData.role}, barangayId=${userData.barangayId}): inArea=${matches}`);
          if (matches) {
            await queueForUser(user.id, {
              kind, targetId: change.doc.id, sourcePath: change.doc.ref.path, revision,
              title: String(alert.title ?? 'LigTAS advisory').slice(0, 100),
              body: String(alert.message ?? alert.description ?? '').slice(0, 500),
            }, `alert:${revision}`);
          }
        }
        if (page.size < 200) break;
        cursor = page.docs[page.docs.length - 1];
      }
      console.log(`Checked ${usersChecked} user(s) for alert ${change.doc.id}.`);
    }
  }, (error) => console.error('Alert watcher failed:', error));
}

const reportCache = new Map<string, any>();
let reportsReady = false;

function startReportWatcher() {
  db.collection('reports').onSnapshot(async (snapshot) => {
    if (!reportsReady) {
      snapshot.docs.forEach((doc) => reportCache.set(doc.id, doc.data()));
      reportsReady = true;
      console.log(`Report watcher ready. Cached ${snapshot.size} existing report(s).`);
      return;
    }

    for (const change of snapshot.docChanges()) {
      if (change.type === 'removed') { reportCache.delete(change.doc.id); continue; }
      const before = reportCache.get(change.doc.id);
      const report = change.doc.data();
      reportCache.set(change.doc.id, report);

      const status = String(report?.verification ?? report?.status ?? '').toLowerCase();
      const beforeStatus = String(before?.verification ?? before?.status ?? '').toLowerCase();
      if (!report?.reporterId || !['verified', 'rejected', 'resolved'].includes(status) || status === beforeStatus) continue;

      console.log(`Report ${change.doc.id} status changed to ${status}, notifying reporter ${report.reporterId}`);

      await queueForUser(report.reporterId, {
        kind: 'report', targetId: change.doc.id, sourcePath: change.doc.ref.path,
        expectedStatus: status, title: 'Report Update', body: `Your report was ${status}. Open LigTAS for details.`,
      }, `report:${change.doc.id}:${Date.now()}`);
    }
  }, (error) => console.error('Report watcher failed:', error));
}

const householdRequestCache = new Map<string, any>();
let householdRequestsReady = false;

function startHouseholdRequestWatcher() {
  db.collection('householdRequests').onSnapshot(async (snapshot) => {
    if (!householdRequestsReady) {
      snapshot.docs.forEach((doc) => householdRequestCache.set(doc.id, doc.data()));
      householdRequestsReady = true;
      console.log(`Household request watcher ready. Cached ${snapshot.size} existing request(s).`);
      return;
    }

    for (const change of snapshot.docChanges()) {
      if (change.type === 'removed') { householdRequestCache.delete(change.doc.id); continue; }
      const before = householdRequestCache.get(change.doc.id);
      const request = change.doc.data();
      householdRequestCache.set(change.doc.id, request);

      if (!request?.userId || !['Approved', 'Rejected'].includes(request.status) || request.status === before?.status) continue;

      console.log(`Household request ${change.doc.id} decided: ${request.status}, notifying user ${request.userId}`);

      await queueForUser(request.userId, {
        kind: 'household', targetId: request.householdId, sourcePath: change.doc.ref.path,
        expectedStatus: request.status, title: 'Household Request', body: `Your household membership request was ${request.status.toLowerCase()}.`,
      }, `household:${change.doc.id}:${Date.now()}`);
    }
  }, (error) => console.error('Household request watcher failed:', error));
}

// --- Delivery processing (kapalit ng dispatchQueuedNotification + deliverNotifications schedule) ---

async function expoRequest(endpoint: string, payload: any) {
  const response = await fetch(`https://exp.host/--/api/v2/push/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Push service HTTP ${response.status}`);
  const json: any = await response.json();
  if (json.errors || !json.data) throw new Error('Push service rejected the request. Check delivery configuration.');
  return json.data;
}

async function finish(ref: DocumentReference, state: string, error: string | null = null) {
  console.log(`Delivery ${ref.id} finished: state=${state}${error ? `, error=${error}` : ''}`);
  await ref.update({ state, error, nextAttemptAt: FieldValue.delete(), updatedAt: now() });
}

async function disableInvalidDevice(path: string, token: string) {
  await db.runTransaction(async (transaction) => {
    const ref = db.doc(path);
    const snapshot = await transaction.get(ref);
    if (snapshot.data()?.token === token) transaction.update(ref, { enabled: false, updatedAt: now() });
  });
}

async function processDelivery(ref: DocumentReference) {
  const job: any = await db.runTransaction(async (transaction) => {
    const current = (await transaction.get(ref)).data();
    if (!current?.nextAttemptAt || current.nextAttemptAt.toMillis() > Date.now()) return null;
    transaction.update(ref, { nextAttemptAt: later(120000), updatedAt: now() });
    return current;
  });
  if (!job) return;
  console.log(`Processing delivery ${ref.id}: kind=${job.kind}, userId=${job.userId}`);

  if (job.expiresAt.toMillis() <= Date.now()) return finish(ref, 'expired');

  try {
    if (job.ticketId) {
      const receipts = await expoRequest('getReceipts', { ids: [job.ticketId] });
      const receipt = receipts[job.ticketId];
      if (!receipt) { await ref.update({ nextAttemptAt: later(15 * 60000) }); return; }
      if (receipt.details?.error === 'DeviceNotRegistered') await disableInvalidDevice(job.devicePath, job.token);
      return finish(ref, receipt.status === 'ok' ? 'delivered_to_provider' : 'failed', receipt.details?.error ?? null);
    }

    const [userSnapshot, deviceSnapshot, sourceSnapshot] = await db.getAll(
      db.doc(`users/${job.userId}`), db.doc(job.devicePath), db.doc(job.sourcePath),
    );
    const user = userSnapshot.data();
    const device = deviceSnapshot.data();
    const source = sourceSnapshot.data();

    if (!user || !source || !enabled(user, job.kind) || !device?.enabled) return finish(ref, 'skipped');
    if (['alert', 'evacuation'].includes(job.kind) && (!published(source) || !inArea(source, user))) return finish(ref, 'skipped');
    if (job.revision && job.revision !== alertRevision(job.targetId, source)) return finish(ref, 'superseded');
    if (job.kind === 'report' && (source.reporterId !== job.userId || String(source.verification ?? source.status).toLowerCase() !== job.expectedStatus)) return finish(ref, 'skipped');
    if (job.kind === 'household' && (source.userId !== job.userId || source.status !== job.expectedStatus)) return finish(ref, 'skipped');
    if (!/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(device.token)) return finish(ref, 'failed', 'Invalid device token');

    const tickets = await expoRequest('send', [{
      to: device.token, sound: 'default', channelId: 'default',
      title: job.title, body: job.body, data: { userId: job.userId, kind: job.kind, targetId: job.targetId },
      ttl: Math.min(3600, Math.max(1, Math.floor((job.expiresAt.toMillis() - Date.now()) / 1000))),
    }]);
    const ticket = tickets[0];

    if (ticket?.status === 'ok' && ticket.id) {
      console.log(`Push sent for delivery ${ref.id}, ticketId=${ticket.id}`);
      await ref.update({ state: 'awaiting_receipt', ticketId: ticket.id, token: device.token, nextAttemptAt: later(15 * 60000), updatedAt: now() });
    } else if (ticket?.details?.error === 'MessageRateExceeded') {
      throw new Error('Push service rate limit');
    } else {
      if (ticket?.details?.error === 'DeviceNotRegistered') await disableInvalidDevice(job.devicePath, device.token);
      await finish(ref, 'failed', ticket?.details?.error ?? 'Missing push ticket');
    }
  } catch (error: any) {
    const attempts = (job.attempts ?? 0) + 1;
    if (attempts >= 8) await finish(ref, 'failed', String(error.message));
    else await ref.update({ attempts, error: String(error.message), nextAttemptAt: later(retryDelay(attempts)), updatedAt: now() });
  }
}

function startDeliveryWorker() {
  // Agad na pagproseso ng bagong deliveries (kapalit ng dispatchQueuedNotification trigger)
  deliveries.onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        console.log(`New delivery queued: ${change.doc.id}`);
        await processDelivery(change.doc.ref).catch((error) => console.error('processDelivery failed:', error));
      }
    }
  }, (error) => console.error('Delivery watcher failed:', error));

  // Retry/receipt sweep bawat 1 minuto (kapalit ng onSchedule 'every 1 minutes')
  setInterval(async () => {
    const due = await deliveries.where('nextAttemptAt', '<=', now()).orderBy('nextAttemptAt').limit(25).get();
    if (due.size > 0) console.log(`Sweep: processing ${due.size} due deliver(y/ies).`);
    for (const item of due.docs) {
      await processDelivery(item.ref).catch((error) => console.error('scheduled processDelivery failed:', error));
    }
  }, 60 * 1000);

  // Cleanup ng lumang records bawat 24 oras (kapalit ng onSchedule 'every 24 hours')
  setInterval(async () => {
    const cutoff = Timestamp.fromMillis(Date.now() - 7 * 24 * 3600000);
    const old = await deliveries.where('expiresAt', '<', cutoff).limit(400).get();
    const batch = db.batch();
    old.docs.forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }, 24 * 60 * 60 * 1000);
}

export function startNotificationWorkers() {
  startAlertWatcher();
  startReportWatcher();
  startHouseholdRequestWatcher();
  startDeliveryWorker();
  console.log('Notification workers started.');
}