import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { logAction } from '../services/auditLog';

const router = Router();
router.use(requireAuth, requireOfficial);

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
router.get('/', async (_req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.collection('alerts').orderBy('createdAt', 'desc').get();
    const alerts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: alerts });
  } catch (error) {
    console.error('List alerts failed:', error);
    res.status(500).json({ error: 'Failed to load alerts.' });
  }
});

// POST /alerts — LGU_ADMIN lang ang pwedeng gumawa/mag-publish
router.post('/', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can create alerts.' });
  }

  const { category, priority, title, message, barangayIds, publish } = req.body ?? {};
  if (!category || !priority || !title || !message) {
    return res.status(400).json({ error: 'category, priority, title, and message are required.' });
  }

  try {
    const validBarangayIds = Array.isArray(barangayIds)
      ? Array.from(new Set(barangayIds.filter((id: string) => barangayNames[id])))
      : [];
    const affectedAreas = validBarangayIds.length
      ? validBarangayIds.map((id) => barangayNames[id])
      : ['All barangays in Balagtas'];

    const now = new Date();
    const docRef = await db.collection('alerts').add({
      alertType: category,
      category,
      priority,
      severityLevel: priority,
      title: String(title).trim(),
      message: String(message).trim(),
      description: String(message).trim(),
      source: 'LGU/MDRRMO',
      status: publish ? 'active' : 'draft',
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
    });

        const created = await docRef.get();
    const createdData = created.data()!;

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: publish ? 'alert_created_and_published' : 'alert_created_draft',
      targetType: 'alert',
      targetId: created.id,
      details: { title: createdData.title, category: createdData.category },
    });

    res.status(201).json({ data: { id: created.id, ...createdData } });
  } catch (error) {
    console.error('Create alert failed:', error);
    res.status(500).json({ error: 'Failed to create alert.' });
  }
});

// PATCH /alerts/:id/publish — hiwalay na endpoint para mag-publish ng draft
router.patch('/:id/publish', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can publish alerts.' });
  }

  try {
    const alertRef = db.doc(`alerts/${req.params.id}`);
    const snapshot = await alertRef.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Alert not found.' });

    await alertRef.update({ status: 'active', publishedAt: new Date(), updatedAt: new Date() });

        const updated = await alertRef.get();
    const updatedData = updated.data()!;

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'alert_published',
      targetType: 'alert',
      targetId: updated.id,
      details: { title: updatedData.title },
    });

    res.json({ data: { id: updated.id, ...updatedData } });
  } catch (error) {
    console.error('Publish alert failed:', error);
    res.status(500).json({ error: 'Failed to publish alert.' });
  }
});

export default router;