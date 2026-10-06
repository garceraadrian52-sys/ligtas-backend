import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /analytics/reports
router.get('/reports', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN' && !req.user!.barangayId) return res.status(403).json({ error: 'A barangay assignment is required.' });
  try {
    const reportsRef = db.collection('reports');
    const query = req.user!.role === 'LGU_ADMIN'
      ? reportsRef
      : reportsRef.where('barangayId', '==', req.user!.barangayId);

    const snapshot = await query.get();

    const byStatus: Record<string, number> = { Pending: 0, Verified: 0, Rejected: 0, Resolved: 0 };
    const byType: Record<string, number> = { flood: 0, road: 0 };
    const byBarangay: Record<string, number> = Object.create(null);

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      const rawStatus = String(data.verification ?? data.status ?? 'Pending').toLowerCase();
      const status = rawStatus.charAt(0).toUpperCase() + rawStatus.slice(1);
      if (Object.prototype.hasOwnProperty.call(byStatus, status)) byStatus[status] += 1;

      const type = String(data.type ?? data.reportType ?? 'flood').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(byType, type)) byType[type] += 1;

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