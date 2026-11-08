import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { listReports } from '../services/reportReads';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';

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

    const reports = await listReports(isLguAdmin ? null : barangayId);
    const floodReports = reports.filter(report => {
      return report.type === 'flood' || report.reportType === 'flood';
    }).map(report => {
      return { id: report.id, location: report.location, description: report.description,
        status: report.status, verification: report.verification, latitude: report.latitude,
        longitude: report.longitude, locationPoint: report.locationPoint, coordinates: report.coordinates };
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
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load map monitoring data.' });
  }
});

export default router;
