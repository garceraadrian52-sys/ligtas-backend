import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /analytics/reports
router.get('/reports', async (req: AuthenticatedRequest, res) => {
  try {
    const reportsRef = db.collection('reports');
    const query = req.user!.role === 'LGU_ADMIN'
      ? reportsRef
      : reportsRef.where('barangayId', '==', req.user!.barangayId);

    const snapshot = await query.get();

    const byStatus: Record<string, number> = { Pending: 0, Verified: 0, Rejected: 0, Resolved: 0 };
    const byType: Record<string, number> = { flood: 0, road: 0 };
    const byBarangay: Record<string, number> = {};

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const status = String(data.verification ?? data.status ?? 'Pending');
      if (status in byStatus) byStatus[status] += 1;

      const type = String(data.type ?? data.reportType ?? 'flood').toLowerCase();
      if (type in byType) byType[type] += 1;

      const barangay = String(data.barangayId ?? 'unassigned');
      byBarangay[barangay] = (byBarangay[barangay] ?? 0) + 1;
    });

    res.json({
      data: {
        total: snapshot.size,
        byStatus,
        byType,
        byBarangay,
      },
    });
  } catch (error) {
    console.error('Report analytics failed:', error);
    res.status(500).json({ error: 'Failed to load report analytics.' });
  }
});

export default router;