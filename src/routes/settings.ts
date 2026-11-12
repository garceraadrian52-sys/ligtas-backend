import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { auditActor, logAction } from '../services/auditLog';
import { areNotificationWorkersStarted } from '../services/notificationWorker';

const router = Router();
router.use(requireAuth);

const defaultPreferences = {
  theme: false,
  autoBackup: true,
  language: 'English',
  timezone: 'Asia/Manila (GMT+8)',
  notifications: { email: true, push: true, critical: true, reports: true },
};
const notificationKeys = ['email', 'push', 'critical', 'reports'] as const;
const backupCollections = ['users', 'reports', 'alerts', 'evacuationCenters', 'roadConditions'] as const;
const backupRecordLimit = 500;

function isSuperAdmin(req: AuthenticatedRequest, res: any) {
  if (req.user?.role === 'SUPER_ADMIN') return true;
  res.status(403).json({ error: 'Only Super Admin can access system administration.' });
  return false;
}

function safeExportValue(value: any): any {
  if (typeof value === 'string') return /^data:[^;]+;base64,/i.test(value) ? '[embedded image omitted from partial backup]' : value;
  if (value == null || typeof value !== 'object') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(safeExportValue);
  const omitted = /(password|token|secret|private.?key|service.?account|api.?key)/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !omitted.test(key))
    .map(([key, child]) => [key, safeExportValue(child)]));
}

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.doc(`userSettings/${req.user!.uid}`).get();
    const stored = snapshot.data() ?? {};
    res.json({ data: {
      ...defaultPreferences,
      ...stored,
      notifications: { ...defaultPreferences.notifications, ...(stored.notifications ?? {}) },
    } });
  } catch (error) {
    console.error('Load settings failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load settings.' });
  }
});

router.patch('/', async (req: AuthenticatedRequest, res) => {
  const body = req.body ?? {};
  const updates: Record<string, unknown> = {};
  const allowedKeys = ['theme', 'autoBackup', 'language', 'timezone', 'notifications'];
  if (Object.keys(body).some(key => !allowedKeys.includes(key))) {
    return res.status(400).json({ error: 'One or more settings are not supported.' });
  }
  if ('theme' in body) {
    if (typeof body.theme !== 'boolean') return res.status(400).json({ error: 'Theme setting is invalid.' });
    updates.theme = body.theme;
  }
  if ('autoBackup' in body) {
    if (typeof body.autoBackup !== 'boolean') return res.status(400).json({ error: 'Backup preference is invalid.' });
    updates.autoBackup = body.autoBackup;
  }
  if ('language' in body) {
    if (!['English', 'Filipino'].includes(body.language)) return res.status(400).json({ error: 'Choose a supported language.' });
    updates.language = body.language;
  }
  if ('timezone' in body) {
    if (!['Asia/Manila (GMT+8)', 'UTC (GMT+0)'].includes(body.timezone)) return res.status(400).json({ error: 'Choose a supported timezone.' });
    updates.timezone = body.timezone;
  }
  if ('notifications' in body) {
    const preferences = body.notifications;
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)
      || Object.keys(preferences).some(key => !notificationKeys.includes(key as typeof notificationKeys[number]))
      || Object.values(preferences).some(value => typeof value !== 'boolean')) {
      return res.status(400).json({ error: 'Notification preferences are invalid.' });
    }
    updates.notifications = preferences;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No supported settings were provided.' });

  try {
    const ref = db.doc(`userSettings/${req.user!.uid}`);
    const previous=(await ref.get()).data() || {};
    const changedFields=Object.keys(updates).filter(key=>JSON.stringify(previous[key])!==JSON.stringify(updates[key]));
    await ref.set({ ...updates, updatedAt: new Date() }, { merge: true });
    if(changedFields.length) await logAction({...auditActor(req.user!),action:'settings_updated',targetType:'settings',targetId:req.user!.uid,details:{changedFields}});
    const snapshot = await ref.get();
    const stored = snapshot.data() ?? {};
    res.json({ data: {
      ...defaultPreferences,
      ...stored,
      notifications: { ...defaultPreferences.notifications, ...(stored.notifications ?? {}) },
    } });
  } catch (error) {
    console.error('Save settings failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

router.get('/backup/status', async (req: AuthenticatedRequest, res) => {
  if (!isSuperAdmin(req, res)) return;
  try {
    const snapshot = await db.doc('systemSettings/backupStatus').get();
    res.json({ data: snapshot.exists ? snapshot.data() : { lastBackupAt: null, collections: [], partial: true } });
  } catch (error) {
    console.error('Load backup status failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load backup status.' });
  }
});

router.post('/backup', async (req: AuthenticatedRequest, res) => {
  if (!isSuperAdmin(req, res)) return;
  try {
    const results = await Promise.all(backupCollections.map(async collection => {
      const snapshot = await db.collection(collection).limit(backupRecordLimit + 1).get();
      return {
        collection,
        records: snapshot.docs.slice(0, backupRecordLimit).map(doc => ({ ...safeExportValue(doc.data()), id: doc.id })),
        truncated: snapshot.size > backupRecordLimit,
      };
    }));
    const exportedAt = new Date();
    const summary = {
      lastBackupAt: exportedAt,
      collections: results.map(({ collection, records, truncated }) => ({ name: collection, count: records.length, truncated })),
      partial: true,
      createdBy: req.user!.uid,
    };
    await db.doc('systemSettings/backupStatus').set(summary, { merge: true });
    await logAction({
      actorId: req.user!.uid, actorName: req.user!.name, actorRole: req.user!.role, actorEmail: req.user!.email, actorBarangayId: req.user!.barangayId,
      action: 'partial_backup_exported', targetType: 'system', targetId: 'partial-backup',
      details: { collections: summary.collections },
    }).catch(error => console.error('Record partial backup export audit failed:', error));
    res.json({ data: {
      format: 'ligtas-partial-backup-v1',
      exportedAt: exportedAt.toISOString(),
      partial: true,
      restoreSupported: false,
      omitted: ['device registrations', 'private credentials', 'embedded image data', 'subcollections'],
      collections: results.map(({ collection, records, truncated }) => ({ name: collection, records, truncated })),
    } });
  } catch (error) {
    console.error('Create partial backup failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to create partial backup export.' });
  }
});

router.get('/system-status', async (req: AuthenticatedRequest, res) => {
  if (!isSuperAdmin(req, res)) return;
  let database: 'online' | 'unavailable' = 'online';
  try {
    await db.doc('systemSettings/statusProbe').get();
  } catch {
    database = 'unavailable';
  }
  const configuredUpdatedAt = process.env.LIGTAS_LAST_UPDATED;
  const parsedUpdatedAt = configuredUpdatedAt ? Date.parse(configuredUpdatedAt) : NaN;
  res.json({ data: {
    version: process.env.LIGTAS_SYSTEM_VERSION || '1.0',
    lastUpdated: Number.isFinite(parsedUpdatedAt) ? new Date(parsedUpdatedAt).toISOString() : null,
    api: 'online',
    database,
    notifications: areNotificationWorkersStarted() ? 'running' : 'disabled',
  } });
});

export default router;
