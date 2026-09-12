import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /audit-logs — LGU_ADMIN lang makakakita ng buong log
router.get('/', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can view audit logs.' });
  }

  try {
    const snapshot = await db.collection('auditLogs').orderBy('timestamp', 'desc').limit(200).get();
    const logs = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: logs });
  } catch (error) {
    console.error('List audit logs failed:', error);
    res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

export default router;