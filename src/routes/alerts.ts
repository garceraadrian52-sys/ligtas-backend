import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { isMunicipalityAdmin } from '../services/roles';
import { auditActor, logActionInTransaction } from '../services/auditLog';
import { alertLifecycle, alertValidity, alertTime, storedAlertValidity } from '../services/alertLifecycle';
import { invalidateFirestoreReadCache } from '../services/firestoreReadCache';

import { validDocumentId } from '../services/inputValidation';
import { automaticAlertsStatus } from '../services/automaticAlerts';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { allocateDisplayId } from '../services/recordDisplayIds';
const router = Router();
router.param('id', (_req, res, next, id) => { if (!validDocumentId(id)) { res.status(400).json({ error: 'Invalid alert ID.' }); return; } next(); });
router.use(requireAuth, requireOfficial);
router.get('/automation', (_req, res) => res.json({ data: automaticAlertsStatus() }));

const barangayNames: Record<string, string> = {
  barangay_borol_1st: 'Borol 1st',
  barangay_borol_2nd: 'Borol 2nd',
  barangay_dalig: 'Dalig',
  barangay_longos: 'Longos',
  barangay_panginay: 'Panginay',
  barangay_pulong_gubat: 'Pulong Gubat',
  barangay_san_juan: 'San Juan',
  barangay_santol: 'Santol',
  barangay_wawa: 'Wawa',
};

function defaultRecommendations(category: string) {
  if (category === 'Evacuation Notice') {
    return [
      'Proceed to the assigned evacuation center when instructed.',
      'Bring IDs, medicines, water, food, and important documents.',
      'Assist children, senior citizens, PWDs, and pregnant household members.',
    ];
  }
  if (category === 'Road Advisory') {
    return [
      'Avoid roads marked limited or not passable.',
      'Use verified alternate routes and wait for LGU updates before travelling.',
      'Report updated road conditions with location and photo evidence when safe.',
    ];
  }
  if (category === 'Weather Advisory') {
    return [
      'Monitor official LGU/MDRRMO announcements.',
      'Prepare emergency supplies and keep mobile devices charged.',
      'Stay alert for flood warnings or evacuation notices.',
    ];
  }
  return [
    'Stay updated through LigTAS official alerts.',
    'Prepare household emergency supplies and documents.',
    'Follow barangay and LGU/MDRRMO instructions.',
  ];
}

// GET /alerts — lahat ng officials (LGU at Barangay) ay makikita lahat
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('alerts').orderBy('createdAt', 'desc').get();
    const alerts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: alerts.filter((alert: any) => alert.status !== 'draft' || isMunicipalityAdmin(req.user!.role)) });
  } catch (error) {
    console.error('List alerts failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load alerts.' });
  }
});

// POST /alerts — LGU_ADMIN lang ang pwedeng gumawa/mag-publish
router.post('/', async (req: AuthenticatedRequest, res) => {
  if (!isMunicipalityAdmin(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can create alerts.' });
  }

  const { category, priority, title, message, barangayIds, publish } = req.body ?? {};
  if (![category, title, message].every(value => typeof value === 'string' && value.trim()) || !['Critical', 'High', 'Normal', 'Low'].includes(priority)) {
    return res.status(400).json({ error: 'category, priority, title, and message are required.' });
  }

  if (title.length > 160 || message.length > 5000 || category.length > 100) return res.status(400).json({ error: 'Use at most 160 characters for the title and 5000 for the message.' });
  if (publish !== undefined && typeof publish !== 'boolean') return res.status(400).json({ error: 'publish must be a boolean.' });
  if (barangayIds !== undefined && (!Array.isArray(barangayIds) || barangayIds.some(id => typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(barangayNames, id)))) return res.status(400).json({ error: 'Select valid barangay target areas.' });

  let validity;
  try { validity=alertValidity(req.body); } catch(error:any) { return res.status(400).json({error:error.message}); }
  try {
    const validBarangayIds = Array.isArray(barangayIds)
      ? Array.from(new Set(barangayIds.filter((id: string) => barangayNames[id])))
      : [];
    const affectedAreas = validBarangayIds.length
      ? validBarangayIds.map((id) => barangayNames[id])
      : ['All barangays in Balagtas'];

    const now = new Date();
    const alertData = {
      ...validity, revision:1,
      alertType: category,
      category,
      priority,
      severityLevel: priority,
      title: String(title).trim(),
      message: String(message).trim(),
      description: String(message).trim(),
      source: 'LGU/MDRRMO',
      status: publish ? 'published' : 'draft',
      coverageArea: validBarangayIds.length ? 'barangay' : 'municipality',
      barangayId: validBarangayIds[0] ?? null,
      affectedAreas,
      locationScope: { type: validBarangayIds.length ? 'barangay' : 'municipality', barangayIds: validBarangayIds },
      recommendations: defaultRecommendations(category),
      createdBy: req.user!.uid,
      createdByName: req.user!.name,
      createdByRole: req.user!.role,
      publishedAt: publish ? now : null,
      createdAt: now,
      updatedAt: now,
    };
    const docRef = db.collection('alerts').doc();
    const displayId = await db.runTransaction(async (transaction) => {
      const displayId = await allocateDisplayId(transaction, db, 'alerts');
      transaction.create(docRef, { ...alertData, displayId });
      logActionInTransaction(transaction,{...auditActor(req.user!),action:publish?'alert_created_and_published':'alert_created_draft',targetType:'alert',targetId:docRef.id,details:{displayId,validityMode:validity.validityMode,expiresAt:validity.expiresAt?.toISOString() || null}});
      return displayId;
    });
    const createdData = { ...alertData, displayId };

    invalidateFirestoreReadCache('auditLogs:');
    res.status(201).json({ data: { id: docRef.id, ...createdData } });
  } catch (error) {
    console.error('Create alert failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to create alert.' });
  }
});


function failure(res:import('express').Response,error:any) {
 if(error.message==='NOT_FOUND')return res.status(404).json({error:'Alert not found.'});
 if(['READ_ONLY','INVALID_STATE'].includes(error.message))return res.status(409).json({error:'Expired and deactivated alerts cannot be changed or republished.'});
 if(error.message==='CONFLICT')return res.status(409).json({error:'This alert changed elsewhere. Refresh before saving.'});
 if(error.message==='INVALID_VALIDITY')return res.status(409).json({error:'Choose a validity option with a future expiration before publishing.'});
 if(respondToFirestoreResourceExhausted(res,error))return;
 console.error('Alert lifecycle update failed:',error?.code || 'unknown');return res.status(500).json({error:'Unable to update this alert.'});
}
router.patch('/:id/publish',async(req:AuthenticatedRequest,res)=>{
 if(!isMunicipalityAdmin(req.user!.role))return res.status(403).json({error:'Only municipality administrators can publish alerts.'});
 try {
  const ref=db.doc('alerts/'+req.params.id);
  const data=await db.runTransaction(async transaction=>{
   const snapshot=await transaction.get(ref);if(!snapshot.exists)throw new Error('NOT_FOUND');
   const current=snapshot.data()!,state=alertLifecycle(current);
   if(state==='published')return current;
   if(state!=='draft')throw new Error('READ_ONLY');
   const validity=storedAlertValidity(current);
   if(validity.validityMode==='scheduled' && (alertTime(validity.expiresAt) ?? 0)<=Date.now())throw new Error('INVALID_VALIDITY');
   const updates={...validity,status:'published',publishedAt:new Date(),updatedAt:new Date(),revision:(current.revision || 0)+1};
   transaction.update(ref,updates);
   logActionInTransaction(transaction,{...auditActor(req.user!),action:'alert_published',targetType:'alert',targetId:ref.id,details:{validityMode:validity.validityMode,expiresAt:alertTime(validity.expiresAt)===null?null:new Date(alertTime(validity.expiresAt)!).toISOString()}});
   return {...current,...updates};
  });invalidateFirestoreReadCache('auditLogs:');res.json({data:{...data,id:ref.id}});
 }catch(error){return failure(res,error);}
});
router.patch('/:id/deactivate',async(req:AuthenticatedRequest,res)=>{
 if(!isMunicipalityAdmin(req.user!.role))return res.status(403).json({error:'Only municipality administrators can deactivate alerts.'});
 const reason=req.body?.reason;
 if(typeof reason!=='string'||!reason.trim()||reason.length>1000)return res.status(400).json({error:'Enter a deactivation reason (up to 1,000 characters).'});
 try{
  const ref=db.doc('alerts/'+req.params.id);
  const data=await db.runTransaction(async transaction=>{
   const snapshot=await transaction.get(ref);if(!snapshot.exists)throw new Error('NOT_FOUND');
   const current=snapshot.data()!;if(alertLifecycle(current)!=='published')throw new Error('READ_ONLY');
   const updates={status:'deactivated',deactivatedBy:req.user!.uid,deactivatedByName:req.user!.name,deactivatedAt:new Date(),deactivationReason:reason.trim(),updatedAt:new Date(),revision:(current.revision || 0)+1};
   transaction.update(ref,updates);
   logActionInTransaction(transaction,{...auditActor(req.user!),action:'alert_deactivated',targetType:'alert',targetId:ref.id,details:{reason:reason.trim(),previousStatus:current.status,status:'deactivated'}});
   return {...current,...updates};
  });invalidateFirestoreReadCache('auditLogs:');res.json({data:{...data,id:ref.id}});
 }catch(error){return failure(res,error);}
});
router.patch('/:id',async(req:AuthenticatedRequest,res)=>{
 if(!isMunicipalityAdmin(req.user!.role))return res.status(403).json({error:'Only municipality administrators can edit alerts.'});
 const {category,priority,title,message,barangayIds,expectedRevision}=req.body ?? {};
 if(![category,title,message].every(value=>typeof value==='string'&&value.trim())||!['Critical','High','Normal','Low'].includes(priority)||title.length>160||message.length>5000||category.length>100||!Array.isArray(barangayIds)||barangayIds.some(id=>typeof id!=='string'||!Object.prototype.hasOwnProperty.call(barangayNames,id))||(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)))return res.status(400).json({error:'Enter valid alert content and target areas.'});
 let requestedValidity:ReturnType<typeof alertValidity>|undefined;
 if(req.body.validityMode!==undefined||Object.prototype.hasOwnProperty.call(req.body,'expiresAt')) {
  try{requestedValidity=alertValidity(req.body);}catch(error:any){return res.status(400).json({error:error.message});}
 }
 const ids=Array.from(new Set<string>(barangayIds));
 try{
  const ref=db.doc('alerts/'+req.params.id);
  const data=await db.runTransaction(async transaction=>{
   const snapshot=await transaction.get(ref);if(!snapshot.exists)throw new Error('NOT_FOUND');
   const current=snapshot.data()!,state=alertLifecycle(current);
   if(!['draft','published'].includes(state))throw new Error('READ_ONLY');
   if(expectedRevision!==undefined&&expectedRevision!==(current.revision || 0))throw new Error('CONFLICT');
   if(state==='published'&&category!==current.category&&category!==current.alertType)throw new Error('INVALID_STATE');
   const validity=requestedValidity ?? storedAlertValidity(current);
   const updates:Record<string,any>={...validity,category,alertType:category,priority,severityLevel:priority,title:title.trim(),message:message.trim(),description:message.trim(),coverageArea:ids.length?'barangay':'municipality',barangayId:ids[0]||null,affectedAreas:ids.length?ids.map(id=>barangayNames[id]):['All barangays in Balagtas'],locationScope:{type:ids.length?'barangay':'municipality',barangayIds:ids}};
   if(state==='draft')updates.recommendations=defaultRecommendations(category);
   const changedFields=Object.keys(updates).filter(key=>key==='expiresAt'?alertTime(current[key])!==alertTime(updates[key]):JSON.stringify(current[key])!==JSON.stringify(updates[key]));
   if(!changedFields.length)return current;
   Object.assign(updates,{updatedAt:new Date(),updatedBy:req.user!.uid,revision:(current.revision || 0)+1});
   transaction.update(ref,updates);
   const auditView=(record:any)=>Object.fromEntries(changedFields.map(key=>[key,key==='expiresAt'?(alertTime(record[key])===null?null:new Date(alertTime(record[key])!).toISOString()):record[key] ?? null]));
   logActionInTransaction(transaction,{...auditActor(req.user!),action:state==='draft'?'alert_draft_updated':'alert_updated',targetType:'alert',targetId:ref.id,details:{changedFields,before:auditView(current),after:auditView(updates)}});
   return {...current,...updates};
  });invalidateFirestoreReadCache('auditLogs:');res.json({data:{...data,id:ref.id}});
 }catch(error){return failure(res,error);}
});
// Draft deletion remains available. Published and historical records can never be deleted.
router.delete('/:id',async(req:AuthenticatedRequest,res)=>{
 if(!isMunicipalityAdmin(req.user!.role))return res.status(403).json({error:'Only municipality administrators can delete drafts.'});
 try{const ref=db.doc('alerts/'+req.params.id);await db.runTransaction(async transaction=>{const snapshot=await transaction.get(ref);if(!snapshot.exists)throw new Error('NOT_FOUND');if(alertLifecycle(snapshot.data())!=='draft')throw new Error('READ_ONLY');transaction.delete(ref);logActionInTransaction(transaction,{...auditActor(req.user!),action:'alert_draft_deleted',targetType:'alert',targetId:ref.id});});invalidateFirestoreReadCache('auditLogs:');res.json({data:{id:ref.id}});}catch(error){return failure(res,error);}
});
export default router;
