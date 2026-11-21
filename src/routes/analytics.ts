import { filterAnalyticsReports, incidentAnalytics, analyticsTrend } from '../services/analyticsFilters';
import { evacuationAnalytics } from '../services/analyticsOverview';
import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { isMunicipalityAdmin } from '../services/roles';
import { summarizeReportAnalytics, validAnalyticsMonth } from '../services/reportAnalytics';
import { presentReportAnalytics } from '../services/reportAnalyticsPresentation';
import { buildAnalyticsOverview } from '../services/analyticsOverview';
import { listReports } from '../services/reportReads';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';

const router = Router();
router.use(requireAuth, requireOfficial);

router.get('/evacuation',async(req:AuthenticatedRequest,res)=>{
 if(!isMunicipalityAdmin(req.user!.role)&&!req.user!.barangayId)return res.status(403).json({error:'A barangay assignment is required.'});
 const area=isMunicipalityAdmin(req.user!.role)?String(req.query.barangayId||''):req.user!.barangayId!;
 const read=(name:string)=>{const collection=db.collection(name);return (area?collection.where('barangayId','==',area):collection).get();};
 try {const [centers,active,barangays]=await Promise.allSettled([read('evacuationCenters'),read('activeEvacuations'),db.collection('barangays').get()]);
 const rows=(result:any)=>result.status==='fulfilled'?result.value.docs.map((doc:any)=>({id:doc.id,...doc.data()})):null;
 res.json({data:evacuationAnalytics(rows(centers),rows(active),rows(barangays)||[])});
 }catch(error){res.status(503).json({error:'Evacuation analytics are unavailable.'});}
});
// GET /analytics/reports
router.get('/reports', async (req: AuthenticatedRequest, res) => {
  const municipalityAdmin = isMunicipalityAdmin(req.user!.role);
  if (!municipalityAdmin && !req.user!.barangayId) return res.status(403).json({ error: 'A barangay assignment is required.' });
  const month = req.query.month;
  if (month !== undefined && !validAnalyticsMonth(month)) return res.status(400).json({ error: 'month must use YYYY-MM (1900–2199).' });
  const start=req.query.start as string|undefined,end=req.query.end as string|undefined,reportType=req.query.reportType as string|undefined,barangayId=req.query.barangayId as string|undefined;
  const validDate=(value:string)=>typeof value==='string'&&/^(19|20|21)\d{2}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if((start&&!validDate(start))||(end&&!validDate(end))||(start&&end&&start>end)||(reportType&&!['all','flood','road'].includes(reportType)))return res.status(400).json({error:'Select a valid date range and report type.'});
  if(barangayId&&!municipalityAdmin&&barangayId!==req.user!.barangayId)return res.status(403).json({error:'This barangay is outside your assigned area.'});
  res.set('Cache-Control', 'no-store');
  try {
    const [allReports, barangaySnapshot] = await Promise.all([
      listReports(municipalityAdmin ? null : req.user!.barangayId),
      db.collection('barangays').get(),
    ]);
    const barangays = barangaySnapshot.docs.map(doc => ({ id: doc.id, name: doc.data().name }));
    if(barangayId&&!barangays.some(item=>item.id===barangayId))return res.status(400).json({error:'Select a valid barangay.'});
    const reports=filterAnalyticsReports(allReports,{start,end,barangayId,reportType});
    const summary = summarizeReportAnalytics(reports, { month: month as string | undefined, barangays });
    const scope = { barangayId: municipalityAdmin ? null : req.user!.barangayId,
      label: municipalityAdmin ? 'Balagtas, Bulacan' : (barangays.find(item => item.id === req.user!.barangayId)?.name || req.user!.barangayId || 'Assigned barangay') };

    const scopedRead = (collection: string) => {
      const ref = db.collection(collection);
      return (municipalityAdmin ? ref : ref.where('barangayId', '==', req.user!.barangayId)).get();
    };
    // Evacuation failures must not hide otherwise available flood analytics.
    const [centersResult, activeResult] = await Promise.allSettled([scopedRead('evacuationCenters'), scopedRead('activeEvacuations')]);
    const centers = centersResult.status === 'fulfilled' ? centersResult.value.docs.map(doc=>({...doc.data(),id:doc.id})) : null;
    const active = activeResult.status === 'fulfilled' ? activeResult.value.docs.map(doc=>({...doc.data(),id:doc.id})) : null;
    const overview = buildAnalyticsOverview(reports,centers,active,barangays,scope.label,{month:month as string | undefined,reportType,now:Date.parse(summary.updatedAt)});
    const incidents = incidentAnalytics(reports), trend = analyticsTrend(reports, start, end);
    if (reportType) {
      overview.metrics[0][1] = reportType === 'flood' ? 'Total Flood Reports' : reportType === 'road' ? 'Total Road Reports' : 'Total Reports';
      overview.metrics[0][3]='Individual report submissions';
      overview.metrics[2][3]='Barangays with verified or resolved reports';
      overview.metrics[3] = ['check', 'Confirmed Incidents', String(incidents.confirmedIncidents), 'Grouped reports count as one incident', 'teal'];
      overview.csvRows = [
        ['LigTAS Reports & Analytics'], ['Scope', scope.label], ['Date range', start || 'All dates', end || 'All dates'], ['Report type', reportType], ['Barangay', barangayId || 'All permitted barangays'], [],
        ['Individual reports', reports.length], ['Confirmed incidents', incidents.confirmedIncidents], ['Grouped incidents', incidents.groupedIncidents], ['Supporting reports', incidents.supportingReports], [],
        ['Status', 'Reports'], ...Object.entries(summary.byStatus), [], ['Barangay', 'Reports'], ...summary.barangays.map(row => [row.name, row.count]), [],
        ['Road', 'Barangay', 'Reports'], ...summary.roads.map(row => [row.name, row.barangay, row.count]), [],
        ['Interval (Manila)', 'Total', 'Verified', 'Resolved', 'Pending', 'Rejected'], ...trend.map(row => [row.date, row.total, row.Verified, row.Resolved, row.Pending, row.Rejected]), [],
        ['Average verification minutes', summary.verification.averageMinutes ?? 'Not recorded'], ['Average resolution minutes', summary.resolution.averageMinutes ?? 'Not recorded'],
      ];
    }
    res.json({
      data: {
        ...summary,
        overview: {...overview, incidents, trend},
        filters:{start:start||null,end:end||null,barangayId:barangayId||null,reportType:reportType||null},
        scope,
        presentation: presentReportAnalytics(summary, scope.label),
      },
    });
  } catch (error) {
    console.error('Report analytics failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load report analytics.' });
  }
});

export default router;
