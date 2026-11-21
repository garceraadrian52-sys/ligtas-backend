import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { Timestamp } from 'firebase-admin/firestore';
import { validDocumentId } from '../services/inputValidation';

const router = Router();
router.use(requireAuth);

// One owner-scoped snapshot keeps the badge and newest 100 items consistent.
// Missing read fields in older delivery records count as unread.
router.get('/inbox', async (req: AuthenticatedRequest, res) => {
  try {
    // Opt-in pagination preserves the response expected by older clients.
    if (req.query.pageSize !== undefined) {
      const size=Number(req.query.pageSize), cursor=req.query.cursor;
      if (typeof req.query.pageSize!=='string' || !Number.isInteger(size) || size<1 || size>100 || (cursor!==undefined && !validDocumentId(cursor)))
        return res.status(400).json({error:'Invalid notification page.'});
      const owner=db.collection('notificationDeliveries').where('userId','==',req.user!.uid);
      const fields=['title','body','description','kind','type','createdAt','read','targetId','targetPath','displayId'];
      const position=cursor ? await db.doc('notificationDeliveries/'+cursor).get() : null;
      if(position && (!position.exists || position.data()?.userId!==req.user!.uid)) return res.status(400).json({error:'Invalid notification page.'});
      let page;
      try {
        page=await db.runTransaction(async transaction=>{
        const total=await transaction.get(owner.count());
        if(total.data().count===0) return {items:[],unreadCount:0,hasMore:false,nextCursor:null};
        const [read,dated]=await Promise.all([transaction.get(owner.where('read','==',true).count()),
          transaction.get(owner.orderBy('createdAt','desc').where('createdAt','>=',Timestamp.fromMillis(0)).count())]);
        // Missing/legacy date fields must remain reachable, including old unread records.
        if(total.data().count===dated.data().count){
          let ordered=owner.orderBy('createdAt','desc');
          if(position) ordered=ordered.startAfter(position);
          const snapshot=await transaction.get(ordered.select(...fields).limit(size+1));
          const items=snapshot.docs.slice(0,size).map(doc=>({...doc.data(),id:doc.id}));
          return {items,unreadCount:total.data().count-read.data().count,hasMore:snapshot.docs.length>size,
            nextCursor:snapshot.docs.length>size?items.at(-1)?.id:null};
        }
        return undefined;
        },{readOnly:true});
      } catch(error:any){
        if(error.code!==9 && error.code!=='failed-precondition') throw error;
        console.warn('Notification pagination index unavailable; retaining compatible inbox reads.',{code:'index-unavailable'});
      }
      if(!page){
        const snapshot=await owner.select(...fields).get();
        const milliseconds=(value:any)=>value?.toMillis?.() ?? (value?.seconds ? value.seconds*1000 : Date.parse(value)||0);
        const all=snapshot.docs.map(doc=>({...doc.data(),id:doc.id})).sort((a:any,b:any)=>milliseconds(b.createdAt)-milliseconds(a.createdAt)||a.id.localeCompare(b.id));
        const offset=position?all.findIndex(item=>item.id===position.id)+1:0;
        const items=all.slice(offset,offset+size), hasMore=all.length>offset+size;
        page={items,unreadCount:all.filter((item:any)=>item.read!==true).length,hasMore,nextCursor:hasMore?items.at(-1)?.id:null};
      }
      res.set('Cache-Control','no-store');
      return res.json({data:page});
    }
    const snapshot = await db.collection('notificationDeliveries').where('userId', '==', req.user!.uid)
      .select('title', 'body', 'description', 'kind', 'type', 'createdAt', 'read', 'targetId', 'targetPath', 'displayId').get();
    const items = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const milliseconds = (value: any) => value?.toMillis?.() ?? (value?.seconds ? value.seconds * 1000 : Date.parse(value) || 0);
    items.sort((a: any, b: any) => milliseconds(b.createdAt) - milliseconds(a.createdAt) || a.id.localeCompare(b.id));
    res.json({data: {items: items.slice(0, 100), unreadCount: items.filter((item: any) => item.read !== true).length}});
  } catch (error) {
    console.error('Load inbox failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({error: 'Failed to load notifications.'});
  }
});

// GET /notifications — deliveries na naka-address sa naka-login na user
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('notificationDeliveries')
      .where('userId', '==', req.user!.uid)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();

    const notifications = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: notifications });
  } catch (error) {
    console.error('List notifications failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load notifications.' });
  }
});

// GET /notifications/preview — top notifications, sa shape na tugma sa web UI (array ng tuples)
router.get('/preview', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('notificationDeliveries')
      .where('userId', '==', req.user!.uid)
      .orderBy('createdAt', 'desc')
      .limit(4)
      .get();

    const preview = snapshot.docs.map((doc) => {
      const data = doc.data();
      const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt ?? Date.now());
      const minutesAgo = Math.max(0, Math.round((Date.now() - createdAt.getTime()) / 60000));
      const timeLabel = minutesAgo < 60 ? `${minutesAgo} minutes ago` : `${Math.round(minutesAgo / 60)} hours ago`;

      return [
        data.title ?? 'Notification',
        data.body ?? '',
        timeLabel,
        !data.read,
      ];
    });

    res.json({ data: preview });
  } catch (error) {
    console.error('Get notification preview failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load notification preview.' });
  }
});

// PATCH /notifications/read-all — DAPAT NASA ITAAS BAGO ANG /:id
router.patch('/read-all', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('notificationDeliveries')
      .where('userId', '==', req.user!.uid)
      .get();

    const unread = snapshot.docs.filter(doc => doc.data().read !== true);
    for (let offset = 0; offset < unread.length; offset += 450) {
      const batch = db.batch();
      unread.slice(offset, offset + 450).forEach(doc => batch.update(doc.ref, {read: true, readAt: new Date()}));
      await batch.commit();
    }
    res.json({data: {updated: unread.length}});
  } catch (error) {
    console.error('Mark all read failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to mark notifications as read.' });
  }
});

// PATCH /notifications/:id — mark as read
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const ref = db.doc(`notificationDeliveries/${req.params.id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Notification not found.' });
    if (snapshot.data()?.userId !== req.user!.uid) {
      return res.status(403).json({ error: 'This notification does not belong to you.' });
    }

    await ref.update({ read: true, readAt: new Date() });
    const updated = await ref.get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update notification failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update notification.' });
  }
});

export default router;
