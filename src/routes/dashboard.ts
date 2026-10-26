import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { summarizeDashboard } from '../services/dashboardSummary';
import { buildBalagtasWaterTrend } from '../services/balagtasMonitoring';
import { balagtasWeather } from '../services/balagtasWeather';
const router = Router();
router.use(requireAuth, requireOfficial);
router.get('/', async (req: AuthenticatedRequest, res) => {
  const isAdmin = req.user!.role === 'LGU_ADMIN';
  const barangayId = req.user!.barangayId;
  if (!isAdmin && !barangayId) return res.status(403).json({ error: 'A barangay assignment is required.' });
  try {
    const reports = db.collection('reports');
    const centers = db.collection('evacuationCenters');
    const [reportSnapshot, alertSnapshot, centerSnapshot] = await Promise.all([
      (isAdmin ? reports : reports.where('barangayId', '==', barangayId)).get(),
      db.collection('alerts').where('status', 'in', ['active', 'published', 'monitoring', 'Active', 'Published', 'Monitoring']).get(),
      (isAdmin ? centers : centers.where('barangayId', '==', barangayId)).get(),
    ]);
    const alerts = alertSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter((item: any) => {
      if (isAdmin) return true;
      const ids = item.locationScope?.barangayIds ?? item.barangayIds ?? (item.barangayId ? [item.barangayId] : []);
      return item.locationScope?.type === 'municipality' || item.coverageArea === 'municipality' || !ids.length || ids.includes(barangayId);
    });
    const reportData=reportSnapshot.docs.map(doc => doc.data());
    res.set('Cache-Control','no-store');
    res.json({ data: { ...summarizeDashboard(reportData, alerts, centerSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }))), waterTrend:buildBalagtasWaterTrend(reportData) } });
  } catch (error) {
    console.error('Dashboard load failed:', error);
    res.status(503).json({ error: 'Dashboard data is temporarily unavailable. Please try again.' });
  }
});
router.get('/weather',async (_req,res)=>{
  res.set('Cache-Control','no-store');
  const data=await balagtasWeather.get();
  if (!data) return res.status(503).json({error:'Weather data for Balagtas is temporarily unavailable. Please retry.'});
  res.json({data});
});
export default router;
