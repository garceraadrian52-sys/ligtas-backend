import { Router } from 'express';
import { canViewAuditLog, publicAuditLog, matchesAuditFilter } from '../services/auditAccess';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { cachedFirestoreRead } from '../services/firestoreReadCache';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /audit-logs — LGU_ADMIN lang makakakita ng buong log
router.get('/', async (req: AuthenticatedRequest, res) => {
  if (!['LGU_ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can view audit logs.' });
  }

  try {
    const logs = await cachedFirestoreRead('auditLogs:latest-200', async () => {
      const snapshot = await db.collection('auditLogs').orderBy('timestamp', 'desc').limit(200).get();
      return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    });
    res.json({ data: logs.filter(log=>canViewAuditLog(req.user!,log)).map(publicAuditLog) });
  } catch (error) {
    console.error('List audit logs failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load audit logs.' });
  }
});

// Single-field timestamp ordering avoids adding composite indexes for every filter combination.
router.get('/search',async(req:AuthenticatedRequest,res)=>{
  if(!['SUPER_ADMIN','LGU_ADMIN'].includes(req.user!.role))return res.status(403).json({error:'Only municipality administrators can view audit logs.'});
  const q=req.query;
  if(Object.values(q).some(value=>typeof value!=='string' || value.length>300) || ['from','to'].some(key=>q[key] && !Number.isFinite(Date.parse(String(q[key])))) || (q.from && q.to && Date.parse(String(q.from))>Date.parse(String(q.to))))return res.status(400).json({error:'Enter valid activity filters and dates.'});
  const limit=Number(q.limit || 100);
  if(!Number.isSafeInteger(limit)||limit<1||limit>200 || (q.cursor && !/^[A-Za-z0-9_-]{1,200}$/.test(String(q.cursor))))return res.status(400).json({error:'Invalid activity page.'});
  try {
    let source=db.collection('auditLogs').orderBy('timestamp','desc');
    if(q.from)source=source.where('timestamp','>=',new Date(String(q.from)));
    if(q.to)source=source.where('timestamp','<=',new Date(String(q.to)));
    if(q.cursor){const cursor=await db.collection('auditLogs').doc(String(q.cursor)).get();if(!cursor.exists)return res.status(400).json({error:'Activity cursor is unavailable. Refresh the logs.'});source=source.startAfter(cursor);}
    const snapshot=await source.limit(limit).get();
    const items=snapshot.docs.map(doc=>({id:doc.id,...doc.data()})).filter(log=>canViewAuditLog(req.user!,log)).map(publicAuditLog).filter(log=>matchesAuditFilter(log,q));
    res.json({data:{items,nextCursor:snapshot.docs.length===limit?snapshot.docs[snapshot.docs.length-1].id:null,hasMore:snapshot.docs.length===limit}});
  }catch(error){if(respondToFirestoreResourceExhausted(res,error))return;res.status(503).json({error:'Activity logs are temporarily unavailable.'});}
});
// There is deliberately no client write, update, or delete route.
export default router;
