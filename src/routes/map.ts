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

    const reportsRef = db.collection('reports');
    const reportsQuery = isLguAdmin ? reportsRef : reportsRef.where('barangayId', '==', barangayId);
    const reportsSnapshot = await reportsQuery.get();
    const floodReports = reportsSnapshot.docs.filter(doc => {
      const report = doc.data();
      return report.type === 'flood' || report.reportType === 'flood';
    }).map(doc => {
      const data = doc.data();
      return { id: doc.id, location: data.location, description: data.description,
        status: data.status, verification: data.verification, latitude: data.latitude,
        longitude: data.longitude, locationPoint: data.locationPoint, coordinates: data.coordinates };
    });
    res.json({
      data: {
        floodReports,
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