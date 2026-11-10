import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { logAction } from '../services/auditLog';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { allocateDisplayId } from '../services/recordDisplayIds';
import { sendAccessRequestRejectionEmail } from '../services/accessRequestEmail';
import { isValidEmail } from '../services/profileFields';

const router = Router();

// POST /access-requests — PUBLIC, walang kailangang login (form bago pa may account)
router.post('/', async (req, res) => {
  const { fullName, email, phone, position, barangay, role, reason } = req.body ?? {};

  if (!fullName || !isValidEmail(email) || !phone || !position || !barangay || !role || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    const now = new Date();
    const requestData = {
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
    };
    const docRef = db.collection('accessRequests').doc();
    const displayId = await db.runTransaction(async (transaction) => {
      const displayId = await allocateDisplayId(transaction, db, 'accessRequests');
      transaction.create(docRef, { ...requestData, displayId });
      return displayId;
    });

    res.status(201).json({ data: { id: docRef.id, displayId, status: 'Pending' } });
  } catch (error) {
    console.error('Create access request failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to submit access request.' });
  }
});

// GET /access-requests — LGU_ADMIN lang, para makita ang mga pending requests
router.get('/', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (!['LGU_ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can view access requests.' });
  }

  try {
    const snapshot = await db.collection('accessRequests').orderBy('createdAt', 'desc').get();
    const requests = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: requests });
  } catch (error) {
    console.error('List access requests failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load access requests.' });
  }
});

// PATCH /access-requests/:id — approve/reject, LGU_ADMIN lang
router.patch('/:id', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (!['LGU_ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can review access requests.' });
  }

  const { status } = req.body ?? {};
  if (!['Approved', 'Rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be Approved or Rejected.' });
  }
  const rejectionReason = typeof req.body?.rejectionReason === 'string' ? req.body.rejectionReason.trim() : '';
  if (status === 'Rejected' && (!rejectionReason || rejectionReason.length > 1500)) {
    return res.status(400).json({ error: 'Enter a rejection reason up to 1500 characters.' });
  }

  try {
    const ref = db.doc(`accessRequests/${req.params.id}`);
    const snapshot = await ref.get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Access request not found.' });
    const request = snapshot.data()!;

    if (status === 'Rejected') {
      if (String(request.status || '').toLowerCase() !== 'pending') {
        return res.status(409).json({ error: 'This access request is no longer pending.' });
      }
      if (!isValidEmail(request.email)) return res.status(400).json({ error: 'The access request does not have a valid email address.' });
      try {
        await sendAccessRequestRejectionEmail({
          email: String(request.email).trim().toLowerCase(),
          fullName: String(request.fullName || ''),
          role: String(request.role || ''),
          reason: rejectionReason,
        });
      } catch (emailError: any) {
        console.error('Send access request rejection email failed:', emailError?.code ?? 'unknown');
        return res.status(503).json({ error: emailError?.code === 'ACCESS_REQUEST_EMAIL_NOT_CONFIGURED'
          ? 'Rejection email is not configured. The request is still pending. Configure SMTP in the backend environment and retry.'
          : 'Could not send the rejection email. The request is still pending. Please retry.' });
      }
    }

    await ref.update({
      status,
      ...(status === 'Rejected' ? { rejectionReason } : {}),
      reviewedBy: req.user!.uid,
      reviewedByName: req.user!.name,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    });

    await logAction({
      actorId: req.user!.uid,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      actorEmail: req.user!.email,
      action: `access_request_${status.toLowerCase()}`,
      targetType: 'accessRequest',
      targetId: String(req.params.id),
      details: { email: request.email, ...(status === 'Rejected' ? { rejectionReason } : {}) },
    });

    const updated = await ref.get();
    res.json({ data: { id: updated.id, ...updated.data() } });
  } catch (error) {
    console.error('Update access request failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update access request.' });
  }
});

export default router;
