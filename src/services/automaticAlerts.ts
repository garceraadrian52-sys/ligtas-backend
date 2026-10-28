import { db } from '../config/firebaseAdmin';
import { balagtasWeather } from './balagtasWeather';
import { automaticReportAlert, automaticReportId, automaticWeatherAlert, isUsableAutomaticWeather } from './automaticAlertPolicy';

export function createAutomaticAlertEngine(store: any, weather: { get(): Promise<any> }, clock = Date.now) {
  async function write(transaction: any, ref: any, previous: any, candidate: any, now: number) {
    if (!candidate) {
      if (!previous || previous.status !== 'active') return false;
      transaction.update(ref, { status: 'resolved', resolvedAt: new Date(now), updatedAt: new Date(now) });
    } else {
      if (previous?.status === 'active' && new Date(previous.expiresAt?.toDate?.() ?? previous.expiresAt).getTime() > now) {
        // Metadata-only edits and subsequent model estimates must not repeat pushes.
        if (previous.message === candidate.message || (candidate.automationSource === 'weather-api' && previous.weatherCode === candidate.weatherCode)) return false;
      }
      transaction.set(ref, { ...candidate, status: 'active', createdBy: 'ligtas-automation', createdByName: 'LigTAS Automatic Alerts',
        createdByRole: 'SYSTEM', createdAt: previous?.createdAt || new Date(now), publishedAt: new Date(now), updatedAt: new Date(now) });
    }
    const audit = store.collection('auditLogs').doc();
    transaction.set(audit, { actorId: 'ligtas-automation', actorName: 'LigTAS Automatic Alerts', actorRole: 'SYSTEM',
      action: candidate ? 'automatic_alert_published' : 'automatic_alert_resolved', targetType: 'alert', targetId: ref.id,
      timestamp: new Date(now), details: { source: candidate?.automationSource || previous?.automationSource } });
    return true;
  }
  return {
    async syncReport(id: string) {
      return store.runTransaction(async (transaction: any) => {
        // Re-read the report inside the transaction to avoid publishing a withdrawn approval.
        const report = await transaction.get(store.doc('reports/' + id));
        const ref = store.doc('alerts/' + automaticReportId(id));
        const old = await transaction.get(ref);
        return write(transaction, ref, old.data(), report.exists ? automaticReportAlert(id, report.data(), clock()) : null, clock());
      });
    },
    async checkWeather() {
      const result = await weather.get();
      if (!isUsableAutomaticWeather(result, clock())) return false; // Outages cannot announce all-clear.
      return store.runTransaction(async (transaction: any) => {
        const ref = store.doc('alerts/automatic_weather');
        const previous = await transaction.get(ref);
        return write(transaction, ref, previous.data(), automaticWeatherAlert(result, clock()), clock());
      });
    },
  };
}

const runtime = { started: false, reportsReady: false, lastReportCheck: null as string | null, lastWeatherCheck: null as string | null, error: null as string | null };
export function automaticAlertsStatus() {
  return { ...runtime, enabled: process.env.ENABLE_AUTOMATIC_ALERTS === 'true', pushDeliveryEnabled: process.env.ENABLE_NOTIFICATION_WORKERS === 'true',
    sources: ['Recent verified flood reports', 'Recent verified closed/limited roads', 'Severe weather model conditions'], weatherIntervalMinutes: 10 };
}
export function startAutomaticAlerts() {
  if (runtime.started) return;
  runtime.started = true;
  const engine = createAutomaticAlertEngine(db, balagtasWeather);
  const pending = new Set<string>();
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (const id of pending) {
        pending.delete(id);
        try { await engine.syncReport(id); runtime.lastReportCheck = new Date().toISOString(); runtime.error = null; }
        catch { pending.add(id); runtime.error = 'Report alert synchronization failed; retrying.'; break; }
      }
    } finally { draining = false; }
  }
  db.collection('reports').where('verification', '==', 'Verified').onSnapshot(snapshot => {
    for (const change of snapshot.docChanges()) pending.add(change.doc.id);
    runtime.reportsReady = true;
    void drain();
  }, () => { runtime.reportsReady = false; runtime.error = 'Report alert listener is unavailable.'; });
  setInterval(() => void drain(), 60000).unref();
  let checkingWeather = false;
  async function weatherCheck() {
    if (checkingWeather) return;
    checkingWeather = true;
    try { await engine.checkWeather(); runtime.lastWeatherCheck = new Date().toISOString(); }
    catch { runtime.error = 'Weather alert synchronization failed; retrying.'; }
    finally { checkingWeather = false; }
  }
  // Let the notification watcher initialize before the first automatic publications.
  setTimeout(() => void weatherCheck(), 30000).unref();
  setInterval(() => void weatherCheck(), 10 * 60000).unref();
}
