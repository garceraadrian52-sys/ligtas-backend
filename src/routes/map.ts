import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /map/monitoring
router.get('/monitoring', async (req: AuthenticatedRequest, res) => {
  try {
    const isLguAdmin = req.user!.role === 'LGU_ADMIN';
    const barangayId = req.user!.barangayId;

    const roadsRef = db.collection('roadConditions');
    const roadsQuery = isLguAdmin ? roadsRef : roadsRef.where('barangayId', '==', barangayId);
    const roadsSnapshot = await roadsQuery.get();

    const centersRef = db.collection('evacuationCenters');
    const centersQuery = isLguAdmin ? centersRef : centersRef.where('barangayId', '==', barangayId);
    const centersSnapshot = await centersQuery.get();

    res.json({
      data: {
        roadConditions: roadsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        evacuationCenters: centersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      },
    });
  } catch (error) {
    console.error('Map monitoring load failed:', error);
    res.status(500).json({ error: 'Failed to load map monitoring data.' });
  }
});

export default router;