import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { summarizeReportAnalytics, validAnalyticsMonth } from '../services/reportAnalytics';
import { presentReportAnalytics } from '../services/reportAnalyticsPresentation';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /analytics/reports
router.get('/reports', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN' && !req.user!.barangayId) return res.status(403).json({ error: 'A barangay assignment is required.' });
  const month = req.query.month;
  if (month !== undefined && !validAnalyticsMonth(month)) return res.status(400).json({ error: 'month must use YYYY-MM (1900–2199).' });
  res.set('Cache-Control', 'no-store');
  try {
    const reportsRef = db.collection('reports');
    const query = req.user!.role === 'LGU_ADMIN'
      ? reportsRef
      : reportsRef.where('barangayId', '==', req.user!.barangayId);

    const [snapshot, barangaySnapshot] = await Promise.all([query.get(), db.collection('barangays').get()]);
    const barangays = barangaySnapshot.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
    const summary = summarizeReportAnalytics(snapshot.docs.map(doc => doc.data()), { month: month as string | undefined, barangays });
    const scope = { barangayId: req.user!.role === 'LGU_ADMIN' ? null : req.user!.barangayId,
      label: req.user!.role === 'LGU_ADMIN' ? 'Balagtas, Bulacan' : (barangays.find(item => item.id === req.user!.barangayId)?.name || req.user!.barangayId || 'Assigned barangay') };

    res.json({
      data: {
        ...summary,
        scope,
        presentation: presentReportAnalytics(summary, scope.label),
      },
    });
  } catch (error) {
    console.error('Report analytics failed:', error);
    res.status(500).json({ error: 'Failed to load report analytics.' });
  }
});

export default router;
