import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireOfficial);

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const isLguAdmin = req.user!.role === 'LGU_ADMIN';
    const barangayId = req.user!.barangayId;

    const reportsRef = db.collection('reports');
    const reportsQuery = isLguAdmin ? reportsRef : reportsRef.where('barangayId', '==', barangayId);
    const reportsSnapshot = await reportsQuery.get();

    let pendingReports = 0;
    let verifiedToday = 0;
    const todayStr = new Date().toDateString();

    reportsSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      const status = String(data.verification ?? data.status ?? '');
      if (status === 'Pending') pendingReports += 1;
      if (status === 'Verified') {
        const verifiedAt = data.verifiedAt?.toDate ? data.verifiedAt.toDate() : data.verifiedAt ? new Date(data.verifiedAt) : null;
        if (verifiedAt && verifiedAt.toDateString() === todayStr) verifiedToday += 1;
      }
    });

    const alertsSnapshot = await db.collection('alerts').where('status', '==', 'active').get();

    const centersRef = db.collection('evacuationCenters');
    const centersQuery = isLguAdmin ? centersRef : centersRef.where('barangayId', '==', barangayId);
    const centersSnapshot = await centersQuery.get();

    let totalOccupied = 0;
    let totalCapacity = 0;
    centersSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      totalOccupied += Number(data.occupied ?? data.currentOccupancy ?? 0);
      totalCapacity += Number(data.capacity ?? data.maxCapacity ?? 0);
    });

    res.json({
      data: {
        pendingReports,
        verifiedToday,
        activeAlerts: alertsSnapshot.size,
        totalReports: reportsSnapshot.size,
        evacuationCenters: {
          count: centersSnapshot.size,
          totalOccupied,
          totalCapacity,
        },
      },
    });
  } catch (error) {
    console.error('Dashboard load failed:', error);
    res.status(500).json({ error: 'Failed to load dashboard data.' });
  }
});

export default router;