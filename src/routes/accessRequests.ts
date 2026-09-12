import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { logAction } from '../services/auditLog';

const router = Router();

// POST /access-requests — PUBLIC, walang kailangang login (form bago pa may account)
router.post('/', async (req, res) => {
  const { fullName, email, phone, position, barangay, role, reason } = req.body ?? {};

  if (!fullName || !email || !phone || !position || !barangay || !role || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const now = new Date();
    const docRef = await db.collection('accessRequests').add({
      fullName: String(fullName).trim(),
      email: String(email).trim().toLowerCase(),
      phone: String(phone).trim(),
      position: String(position).trim(),
      barangay,
      role,
      reason: String(reason).trim(),
      status: 'Pending',
      createdAt: now,
      updatedAt: now,
    });

    res.status(201).json({ data: { id: docRef.id, status: 'Pending' } });
  } catch (error) {
    console.error('Create access request failed:', error);
    res.status(500).json({ error: 'Failed to submit access request.' });
  }
});

// GET /access-requests — LGU_ADMIN lang, para makita ang mga pending requests
router.get('/', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can view access requests.' });
  }

  try {
    const snapshot = await db.collection('accessRequests').orderBy('createdAt', 'desc').get();
    const requests = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: requests });
  } catch (error) {
    console.error('List access requests failed:', error);
    res.status(500).json({ error: 'Failed to load access requests.' });
  }
});

// PATCH /access-requests/:id — approve/reject, LGU_ADMIN lang
router.patch('/:id', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can review access requests.' });
  }

  const { status } = req.body ?? {};
  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be Approved or Rejected.' });
  }

  try {
    const ref = db.doc(`accessRequests/${req.params.id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Access request not found.' });

    await ref.update({
      status,
      reviewedBy: req.user!.uid,
      reviewedByName: req.user!.name,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    });

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      action: `access_request_${status.toLowerCase()}`,
      targetType: 'accessRequest',
      targetId: String(req.params.id),
      details: { email: snapshot.data()?.email },
    });

    const updated = await ref.get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update access request failed:', error);
    res.status(500).json({ error: 'Failed to update access request.' });
  }
});

export default router;