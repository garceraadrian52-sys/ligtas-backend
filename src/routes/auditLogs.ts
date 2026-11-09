import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { cachedFirestoreRead } from '../services/firestoreReadCache';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /audit-logs — LGU_ADMIN lang makakakita ng buong log
router.get('/', async (req: AuthenticatedRequest, res) => {
  if (!['LGU_ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can view audit logs.' });
  }

  try {
    const logs = await cachedFirestoreRead('auditLogs:latest-200', async () => {
      const snapshot = await db.collection('auditLogs').orderBy('timestamp', 'desc').limit(200).get();
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    });
    res.json({ data: logs });
  } catch (error) {
    console.error('List audit logs failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

export default router;
