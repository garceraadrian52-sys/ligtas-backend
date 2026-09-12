import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

// GET /notifications — deliveries na naka-address sa naka-login na user
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('notificationDeliveries')
      .where('userId', '==', req.user!.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const notifications = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: notifications });
  } catch (error) {
    console.error('List notifications failed:', error);
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

// GET /notifications/preview — halimbawa/preview lang, hindi galing sa totoong deliveries
router.get('/preview', async (req: AuthenticatedRequest, res) => {
  res.json({
    data: {
      title: 'Sample Notification',
      body: 'This is a preview of how a notification will appear.',
    },
  });
});

// PATCH /notifications/:id — mark as read
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const ref = db.doc(`notificationDeliveries/${req.params.id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Notification not found.' });
    if (snapshot.data()?.userId !== req.user!.uid) {
      return res.status(403).json({ error: 'This notification does not belong to you.' });
    }

    await ref.update({ read: true, readAt: new Date() });
    const updated = await ref.get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update notification failed:', error);
    res.status(500).json({ error: 'Failed to update notification.' });
  }
});

// PATCH /notifications/read-all
router.patch('/read-all', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('notificationDeliveries')
      .where('userId', '==', req.user!.uid)
      .where('read', '!=', true)
      .get();

    const batch = db.batch();
    snapshot.docs.forEach((doc) => batch.update(doc.ref, { read: true, readAt: new Date() }));
    await batch.commit();

    res.json({ data: { updated: snapshot.size } });
  } catch (error) {
    console.error('Mark all read failed:', error);
    res.status(500).json({ error: 'Failed to mark notifications as read.' });
  }
});

export default router;