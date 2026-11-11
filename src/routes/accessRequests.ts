import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { logActionInTransaction } from '../services/auditLog';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { allocateDisplayId } from '../services/recordDisplayIds';
import { sendAccessRequestRejectionEmail } from '../services/accessRequestEmail';
import { isValidEmail } from '../services/profileFields';
import { validDocumentId } from '../services/inputValidation';

const router = Router();
const accessRequestRoles = [
  { value: 'Barangay Official', label: 'Barangay Official' },
  { value: 'LGU Staff', label: 'LGU Staff' },
] as const;

function normalizedBarangay(value: unknown) {
  return typeof value === 'string'
    ? value.trim().replace(/^barangay\s+/i, '').replace(/_/g, ' ').toLowerCase()
    : '';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

// GET /access-requests/options — Public fields required by the access request form.
router.get('/options', async (_req, res) => {
  try {
    const snapshot = await db.collection('barangays').get();
    const barangays = snapshot.docs
      .map(doc => {
        const data = doc.data();
        const name = typeof data.name === 'string' ? data.name.trim()
          : typeof data.displayName === 'string' ? data.displayName.trim() : '';
        return name ? { id: doc.id, name, label: /^barangay\s+/i.test(name) ? name : `Barangay ${name}` } : null;
      })
      .filter((barangay): barangay is { id: string; name: string; label: string } => barangay !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
    return res.json({ data: { roles: accessRequestRoles, barangays } });
  } catch (error) {
    console.error('Load access request options failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    return res.status(503).json({ error: 'Access request options are temporarily unavailable.' });
  }
});

// POST /access-requests — Public access request submission
router.post('/', async (req, res) => {
  const { fullName, email, phone, position, barangay, barangayId, role, reason } = req.body ?? {};
  const nameText = typeof fullName === 'string' ? fullName.trim() : '';
  const emailText = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const phoneText = typeof phone === 'string' ? phone.trim() : '';
  const positionText = typeof position === 'string' ? position.trim() : '';
  const reasonText = typeof reason === 'string' ? reason.trim() : '';

  if (!nameText || nameText.length > 200 || !isValidEmail(emailText)
    || !phoneText || phoneText.length > 40 || !positionText || positionText.length > 120
    || !reasonText || reasonText.length > 1500 || typeof barangay !== 'string' || !barangay.trim()
    || !accessRequestRoles.some(option => option.value === role)) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (barangayId !== undefined && !validDocumentId(barangayId)) {
    return res.status(400).json({ error: 'Choose a valid barangay.' });
  }

  try {
    let resolvedBarangayId: string | null = null;
    let resolvedBarangayName = barangay.trim();
    if (barangayId) {
      const barangaySnapshot = await db.doc(`barangays/${barangayId}`).get();
      if (!barangaySnapshot.exists) return res.status(400).json({ error: 'Choose a valid barangay.' });
      const data = barangaySnapshot.data() ?? {};
      const name = typeof data.name === 'string' ? data.name.trim()
        : typeof data.displayName === 'string' ? data.displayName.trim() : '';
      if (!name || normalizedBarangay(name) !== normalizedBarangay(barangay)) {
        return res.status(400).json({ error: 'The selected barangay does not match its saved record.' });
      }
      resolvedBarangayId = barangaySnapshot.id;
      resolvedBarangayName = name;
    } else {
      // Keep compatibility with older web clients that submit the barangay label only.
      const snapshot = await db.collection('barangays').get();
      const match = snapshot.docs.find(doc => {
        const data = doc.data();
        return normalizedBarangay(data.name ?? data.displayName ?? doc.id) === normalizedBarangay(barangay);
      });
      if (!match) return res.status(400).json({ error: 'Choose a valid barangay.' });
      const data = match.data();
      resolvedBarangayId = match.id;
      resolvedBarangayName = typeof data.name === 'string' ? data.name.trim()
        : typeof data.displayName === 'string' ? data.displayName.trim() : barangay.trim();
    }

    const now = new Date();

    const requestData = {
      fullName: nameText,
      email: emailText,
      phone: phoneText,
      position: positionText,
      barangay: resolvedBarangayName,
      barangayId: resolvedBarangayId,
      role,
      reason: reasonText,
      status: 'Pending',
      createdAt: now,
      updatedAt: now,
    };

    const docRef = db.collection('accessRequests').doc();

    const result = await db.runTransaction(async transaction => {
      const duplicateQuery = db.collection('accessRequests')
        .where('email', '==', emailText);
      const duplicate = await transaction.get(duplicateQuery);
      if (duplicate.docs.some(item => String(item.data()?.status ?? '').toLowerCase() === 'pending')) {
        return { state: 'duplicate' as const };
      }

      const nextId = await allocateDisplayId(transaction, db, 'accessRequests');

      transaction.create(docRef, {
        ...requestData,
        displayId: nextId,
      });

      return { state: 'created' as const, displayId: nextId };
    });

    if (result.state === 'duplicate') {
      return res.status(409).json({ error: 'A pending access request already exists for this email address.' });
    }

    return res.status(201).json({
      data: {
        id: docRef.id,
        displayId: result.displayId,
        status: 'Pending',
      },
    });
  } catch (error) {
    console.error('Create access request failed:', error);

    if (respondToFirestoreResourceExhausted(res, error)) return;

    return res.status(500).json({
      error: 'Failed to submit access request.',
    });
  }
});

// GET /access-requests — Municipality administrators only
router.get('/', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (!['LGU_ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({
      error: 'Only municipality administrators can view access requests.',
    });
  }

  try {
    const snapshot = await db.collection('accessRequests')
      .orderBy('createdAt', 'desc')
      .get();

    const requests = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ data: requests });
  } catch (error) {
    console.error('List access requests failed:', error);

    if (respondToFirestoreResourceExhausted(res, error)) return;

    return res.status(500).json({
      error: 'Failed to load access requests.',
    });
  }
});

// PATCH /access-requests/:id — Reject access requests
// Approval is handled by POST /users with accessRequestId.
router.patch('/:id', requireAuth, requireOfficial, async (req: AuthenticatedRequest, res) => {
  if (!['LGU_ADMIN', 'SUPER_ADMIN'].includes(req.user!.role)) {
    return res.status(403).json({
      error: 'Only municipality administrators can review access requests.',
    });
  }

  // Prevent approval without account registration.
  if (req.body?.status !== 'Rejected') {
    return res.status(400).json({
      error: 'Approve requests through account registration.',
    });
  }

  if (!validDocumentId(req.params.id)) {
    return res.status(400).json({ error: 'Access request ID is invalid.' });
  }

  const rejectionReason =
    typeof req.body?.rejectionReason === 'string'
      ? req.body.rejectionReason.trim()
      : '';

  if (!rejectionReason || rejectionReason.length > 1500) {
    return res.status(400).json({
      error: 'Enter a rejection reason up to 1500 characters.',
    });
  }

  try {
    const ref = db.doc(`accessRequests/${req.params.id}`);

    // Save rejection and audit log in one transaction.
    const result = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);

      if (!snapshot.exists) {
        return { state: 'missing' as const };
      }

      const request = snapshot.data()!;

      const requestEmail = typeof request.email === 'string' ? request.email : '';
      const requestFullName = typeof request.fullName === 'string' ? request.fullName : '';
      const requestRole = typeof request.role === 'string' ? request.role : '';

      if (String(request.status || '').toLowerCase() !== 'pending') {
        return { state: 'conflict' as const };
      }

      const now = new Date();

      const changes = {
        status: 'Rejected',
        rejectionReason,
        reviewedBy: req.user!.uid,
        reviewedByName: req.user!.name,
        reviewedAt: now,
        updatedAt: now,
      };

      transaction.update(ref, changes);

      logActionInTransaction(transaction, {
        actorId: req.user!.uid,
        actorName: req.user!.name,
        actorRole: req.user!.role,
        actorEmail: req.user!.email, actorBarangayId: req.user!.barangayId,
        action: 'access_request_rejected',
        targetType: 'accessRequest',
        targetId: String(req.params.id),
        details: {
          email: requestEmail,
          rejectionReason,
        },
      });

      return {
        state: 'rejected' as const,
        data: {
          id: snapshot.id,
          ...request,
          ...changes,
          email: requestEmail,
          fullName: requestFullName,
          role: requestRole,
        },
      };
    });

    if (result.state === 'missing') {
      return res.status(404).json({
        error: 'Access request not found.',
      });
    }

    if (result.state === 'conflict') {
      return res.status(409).json({
        error: 'This access request is no longer pending.',
      });
    }

    // Email is optional and must not prevent rejection.
    let emailSent = false;

    const smtpConfigured = [
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
    ].every(key => Boolean(process.env[key]?.trim()));

    if (smtpConfigured && isValidEmail(result.data.email)) {
      try {
        await sendAccessRequestRejectionEmail({
          email: String(result.data.email).trim().toLowerCase(),
          fullName: String(result.data.fullName || ''),
          role: String(result.data.role || ''),
          reason: rejectionReason,
        });

        emailSent = true;
      } catch (emailError: unknown) {
        console.error(
          'Rejection email delivery failed:',
          errorCode(emailError) ?? 'unknown'
        );
      }
    }

    return res.json({
      data: result.data,
      notification: {
        emailSent,
      },
    });
  } catch (error) {
    console.error('Update access request failed:', error);

    if (respondToFirestoreResourceExhausted(res, error)) return;

    return res.status(500).json({
      error: 'Failed to update access request.',
    });
  }
});

export default router;
