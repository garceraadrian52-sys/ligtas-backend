import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

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
    await ref.set({ ...updates, updatedAt: new Date() }, { merge: true });
    const snapshot = await ref.get();
    const stored = snapshot.data() ?? {};
    res.json({ data: {
      ...defaultPreferences,
      ...stored,
      notifications: { ...defaultPreferences.notifications, ...(stored.notifications ?? {}) },
    } });
  } catch (error) {
    console.error('Save settings failed:', error);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

// Backups are intentionally reported as unavailable until a real export is configured.
router.post('/backup', (_req, res) => {
  res.status(501).json({ error: 'Backup downloads are not configured yet.' });
});

export default router;
