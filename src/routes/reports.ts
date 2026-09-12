import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { logAction } from '../services/auditLog';

const router = Router();
router.use(requireAuth, requireOfficial);

// GET /reports
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const reportsRef = db.collection('reports');
    const query = req.user!.role === 'LGU_ADMIN'
      ? reportsRef
      : reportsRef.where('barangayId', '==', req.user!.barangayId);

    const snapshot = await query.get();
    const reports = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: reports });
  } catch (error) {
    console.error('List reports failed:', error);
    res.status(500).json({ error: 'Failed to load reports.' });
  }
});

// GET /reports/:id
router.get('/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const snapshot = await db.doc(`reports/${req.params.id}`).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Report not found.' });

    const data = snapshot.data()!;
    if (req.user!.role !== 'LGU_ADMIN' && data.barangayId !== req.user!.barangayId) {
      return res.status(403).json({ error: 'This report belongs to another barangay.' });
    }

    res.json({ data: { id: snapshot.id, ...data } });
  } catch (error) {
    console.error('Get report failed:', error);
    res.status(500).json({ error: 'Failed to load report.' });
  }
});

// PATCH /reports/:id — para sa verify/reject mula sa web dashboard
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  const { status } = req.body ?? {};
  if (!['Pending', 'Verified', 'Rejected', 'Resolved'].includes(status)) {
    return res.status(400).json({ error: 'status must be Pending, Verified, Rejected, or Resolved.' });
  }

  try {
    const reportRef = db.doc(`reports/${req.params.id}`);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reportRef);
      if (!snapshot.exists) throw new Error('NOT_FOUND');

      const data = snapshot.data()!;
      if (req.user!.role !== 'LGU_ADMIN' && data.barangayId !== req.user!.barangayId) {
        throw new Error('FORBIDDEN');
      }

      const roadRef = data.roadConditionId ? db.doc(`roadConditions/${data.roadConditionId}`) : null;
      const roadSnap = roadRef ? await transaction.get(roadRef) : null;

      const updates: Record<string, any> = {
        status,
        verification: status,
        reviewedBy: req.user!.uid,
        reviewedByName: req.user!.name,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      };
      if (status === 'Verified') {
        updates.verifiedBy = req.user!.uid;
        updates.verifiedByName = req.user!.name;
        updates.verifiedAt = new Date();
      }

      transaction.update(reportRef, updates);

      if (roadRef && roadSnap?.exists) {
        transaction.update(roadRef, { verification: status, reportStatus: status, updatedAt: new Date() });
      }
    });

        const updated = await reportRef.get();
    const updatedData = updated.data()!;

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: `report_${status.toLowerCase()}`,
      targetType: 'report',
      targetId: updated.id,
      details: { location: updatedData.location, status },
    });

    res.json({ data: { id: updated.id, ...updatedData } });
  } catch (error: any) {
    if (error.message === 'NOT_FOUND') return res.status(404).json({ error: 'Report not found.' });
    if (error.message === 'FORBIDDEN') return res.status(403).json({ error: 'This report belongs to another barangay.' });
    console.error('Update report failed:', error);
    res.status(500).json({ error: 'Failed to update report.' });
  }
});

export default router;

// POST /reports — para sa officials na direktang magsumite ng report mula sa web
router.post('/', async (req: AuthenticatedRequest, res) => {
  const { type, location, description, waterLevel, roadStatus, floodingLevel, cause, barangayId } = req.body ?? {};

  if (!type || !location || !description) {
    return res.status(400).json({ error: 'type, location, and description are required.' });
  }
  if (!['flood', 'road'].includes(type)) {
    return res.status(400).json({ error: 'type must be flood or road.' });
  }

  const targetBarangayId = req.user!.role === 'LGU_ADMIN' ? (barangayId ?? null) : req.user!.barangayId;

  try {
    const now = new Date();
    const baseData: Record<string, any> = {
      type,
      reportType: type,
      location: String(location).trim(),
      description: String(description).trim(),
      status: 'Verified',
      verification: 'Verified',
      submittedByOfficial: true,
      reporterId: req.user!.uid,
      reporterName: req.user!.name,
      createdByRole: req.user!.role,
      barangayId: targetBarangayId,
      verifiedBy: req.user!.uid,
      verifiedByName: req.user!.name,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    if (type === 'flood') {
      baseData.waterLevel = waterLevel ?? 'Not specified';
    } else {
      baseData.roadStatus = roadStatus ?? 'Not specified';
      baseData.floodingLevel = floodingLevel ?? 'Not specified';
      baseData.cause = cause ?? 'Not specified';
    }

    const docRef = await db.collection('reports').add(baseData);

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: 'report_submitted_by_official',
      targetType: 'report',
      targetId: docRef.id,
      details: { type, location },
    });

    const created = await docRef.get();
    res.status(201).json({ data: { id: created.id, ...created.data() } });
  } catch (error) {
    console.error('Submit report failed:', error);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
});