import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { isMunicipalityAdmin } from '../services/roles';

import { validDocumentId, validText } from '../services/inputValidation';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { allocateDisplayId } from '../services/recordDisplayIds';
import { logActionInTransaction } from '../services/auditLog';
import { invalidateFirestoreReadCache } from '../services/firestoreReadCache';
const router = Router();
router.use(requireAuth, requireOfficial);

function timestampVersion(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? timestampVersion(value.getTime()) : 'invalid-date';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'invalid-number';
    const seconds = Math.floor(value / 1000);
    return `${seconds}:${(value - seconds * 1000) * 1_000_000}`;
  }
  if (typeof value === 'string') {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? timestampVersion(milliseconds) : `invalid-string:${value}`;
  }
  if (typeof value.toDate === 'function') return timestampVersion(value.toDate());
  const seconds = value.seconds ?? value._seconds;
  const nanoseconds = value.nanoseconds ?? value._nanoseconds;
  if (Number.isInteger(seconds) && Number.isInteger(nanoseconds)) return `${seconds}:${nanoseconds}`;
  return `opaque:${JSON.stringify(value)}`;
}

function updateError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

// GET /evacuation-centers
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const centersRef = db.collection('evacuationCenters');
    const query = isMunicipalityAdmin(req.user!.role)
      ? centersRef
      : centersRef.where('barangayId', '==', req.user!.barangayId);

    const snapshot = await query.get();
    const centers = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: centers });
  } catch (error) {
    console.error('List evacuation centers failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load evacuation centers.' });
  }
});

// GET /evacuation-centers/:id/occupants — live, checked-in household members.
router.get('/:id/occupants', async (req: AuthenticatedRequest, res) => {
  try {
    const center = await db.doc(`evacuationCenters/${req.params.id}`).get();
    if (!center.exists) return res.status(404).json({ error: 'Evacuation center not found.' });
    const centerData = center.data()!;
    if (!isMunicipalityAdmin(req.user!.role) && centerData.barangayId !== req.user!.barangayId) {
      return res.status(403).json({ error: 'This center belongs to another barangay.' });
    }
    const records = await db.collection('evacuationRecords')
      .where('evacuationCenterId', '==', req.params.id).get();
    const activeRecords = records.docs.filter((record) => record.data().status !== 'checked_out');
    const householdIds = [...new Set(activeRecords
      .map(record => String(record.data().householdId ?? ''))
      .filter(id => /^H-[A-Z0-9-]{5,36}$/i.test(id)))];
    const householdSnapshots = await Promise.all(householdIds.map(id => db.doc(`households/${id}`).get()));
    const householdDisplayIds = new Map(householdSnapshots
      .filter(snapshot => snapshot.exists)
      .map(snapshot => [snapshot.id, snapshot.data()?.displayId]));
    const households = activeRecords.map((record) => {
      const data = record.data();
      const names: string[] = Array.isArray(data.memberNames) ? data.memberNames : [];
      const relationships: string[] = Array.isArray(data.memberRelationships) ? data.memberRelationships : [];
      const rawDisplayId = householdDisplayIds.get(String(data.householdId ?? ''));
      return {
        id: record.id,
        household: data.householdName || 'Household',
        householdDisplayId: typeof rawDisplayId === 'string' && /^HH-\d{5,}$/i.test(rawDisplayId) ? rawDisplayId.toUpperCase() : null,
        members: (Array.isArray(data.memberIds) ? data.memberIds : []).map((id: string, index: number) => ({
          name: names[index] || id,
          relationship: relationships[index] || 'Household member',
        })),
      };
    });
    res.json({ data: households });
  } catch (error) {
    console.error('List evacuation occupants failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load current occupants.' });
  }
});

// POST /evacuation-centers — LGU_ADMIN lang
router.post('/', async (req: AuthenticatedRequest, res) => {
  if (!isMunicipalityAdmin(req.user!.role)) {
    return res.status(403).json({ error: 'Only municipality administrators can register evacuation centers.' });
  }

  const { name, barangayId, capacity, address, latitude, longitude, facilities, contactPerson, contactNumber, occupied = 0 } = req.body ?? {};
  if (!validText(name, 200) || !validText(barangayId, 1500) || capacity === undefined) {
    return res.status(400).json({ error: 'name, barangayId, and capacity are required.' });
  }

  if ([address, contactPerson, contactNumber].some(value => value != null && (typeof value !== 'string' || value.length > 500))) return res.status(400).json({ error: 'Address and contact fields must be text of at most 500 characters.' });
  if (!['number', 'string'].includes(typeof capacity) || !['number', 'string'].includes(typeof occupied) || capacity === null || occupied === null || String(capacity).trim() === '' || String(occupied).trim() === '') return res.status(400).json({ error: 'Capacity and occupancy must be valid whole numbers.' });
  const hasLat = latitude !== undefined && latitude !== null;
  const hasLng = longitude !== undefined && longitude !== null;
  if (!Number.isSafeInteger(Number(capacity)) || Number(capacity) <= 0 || !Number.isSafeInteger(Number(occupied)) || Number(occupied) < 0 || Number(occupied) > Number(capacity)) return res.status(400).json({error: 'Capacity and occupancy must be valid whole numbers.'});
  if (hasLat !== hasLng || (hasLat && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180))) return res.status(400).json({error: 'Enter valid latitude and longitude together.'});
  if (typeof barangayId !== 'string' || barangayId.includes('/')) return res.status(400).json({error: 'Invalid barangay ID.'});
  try {
    if (!(await db.doc('barangays/' + barangayId).get()).exists) return res.status(400).json({error: 'Barangay does not exist.'});
    const now = new Date();
    const centerData = {
      name: String(name).trim(),
      barangayId,
      address: address ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      capacity: Number(capacity),
      maxCapacity: Number(capacity),
      occupied: Number(occupied),
      currentOccupancy: Number(occupied),
      facilities: Array.isArray(facilities) ? facilities.filter(value => typeof value === 'string') : [],
      contactPerson: typeof contactPerson === 'string' ? contactPerson : null,
      contactNumber: typeof contactNumber === 'string' ? contactNumber : null,
      status: 'OPEN',
      createdBy: req.user!.uid,
      createdAt: now,
      updatedAt: now,
    };
    const docRef = db.collection('evacuationCenters').doc();
    const displayId = await db.runTransaction(async (transaction) => {
      const displayId = await allocateDisplayId(transaction, db, 'evacuationCenters');
      transaction.create(docRef, { ...centerData, displayId });
      return displayId;
    });
    res.status(201).json({ data: { id: docRef.id, ...centerData, displayId } });
  } catch (error) {
    console.error('Create evacuation center failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to register evacuation center.' });
  }
});

// PATCH /evacuation-centers/:id — only Super Admin may edit an existing center.
router.patch('/:id', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Only Super Admin can edit evacuation center details.' });
  }
  const centerId = req.params.id;
  if (!validDocumentId(centerId)) return res.status(400).json({ error: 'Invalid evacuation center ID.' });

  const body = req.body ?? {};
  if (!Object.prototype.hasOwnProperty.call(body, 'expectedUpdatedAt')) {
    return res.status(400).json({ error: 'Refresh the evacuation center before saving your changes.' });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  const barangayId = body.barangayId;
  const capacity = typeof body.capacity === 'number' || typeof body.capacity === 'string' ? Number(body.capacity) : NaN;
  const latitude = body.latitude === null || body.latitude === '' ? null : Number(body.latitude);
  const longitude = body.longitude === null || body.longitude === '' ? null : Number(body.longitude);
  const contactPerson = typeof body.contactPerson === 'string' ? body.contactPerson.trim() : '';
  const contactNumber = typeof body.contactNumber === 'string' ? body.contactNumber.trim() : '';
  const status = String(body.status ?? '').trim().toUpperCase();
  const facilities = body.facilities;

  if (!validText(name, 200) || !validText(address, 500) || !validDocumentId(barangayId)) {
    return res.status(400).json({ error: 'Enter a center name, complete address, and valid barangay.' });
  }
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    return res.status(400).json({ error: 'Capacity must be a positive whole number.' });
  }
  const hasLatitude = latitude !== null && Number.isFinite(latitude) && Math.abs(latitude) <= 90;
  const hasLongitude = longitude !== null && Number.isFinite(longitude) && Math.abs(longitude) <= 180;
  if ((latitude !== null && !hasLatitude) || (longitude !== null && !hasLongitude) || (hasLatitude !== hasLongitude)) {
    return res.status(400).json({ error: 'Enter valid latitude and longitude together, or leave both blank.' });
  }
  if (status !== 'OPEN' && status !== 'CLOSED') {
    return res.status(400).json({ error: 'Choose Open or Closed. Full availability is calculated from occupancy.' });
  }
  if ([contactPerson, contactNumber].some(value => value.length > 500)) {
    return res.status(400).json({ error: 'Contact fields must be at most 500 characters.' });
  }
  if (!Array.isArray(facilities) || facilities.length > 50 || facilities.some(value => typeof value !== 'string' || value.trim().length > 100)) {
    return res.status(400).json({ error: 'Choose valid center facilities.' });
  }

  try {
    if (!(await db.doc(`barangays/${barangayId}`).get()).exists) {
      return res.status(400).json({ error: 'Barangay does not exist.' });
    }

    const centerRef = db.doc(`evacuationCenters/${centerId}`);
    const result = await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(centerRef);
      if (!snapshot.exists) throw updateError('Evacuation center not found.', 404);
      const current = snapshot.data()!;
      if (timestampVersion(current.updatedAt) !== timestampVersion(body.expectedUpdatedAt)) {
        throw updateError('This center changed after you opened it. Refresh the details and review the latest values before saving.', 409);
      }

      const occupied = Number(current.occupied ?? current.currentOccupancy ?? current.occupancyCount ?? 0);
      if (!Number.isSafeInteger(occupied) || occupied < 0) {
        throw updateError('Current occupancy needs reconciliation before this center can be edited.', 409);
      }
      if (capacity < occupied) {
        throw updateError(`Capacity cannot be lower than the ${occupied} people currently checked in.`, 409);
      }
      const currentOperationalStatus = String(current.status ?? 'OPEN').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN';
      if (status === 'CLOSED' && currentOperationalStatus !== 'CLOSED' && occupied > 0) {
        throw updateError('Check out all current occupants before closing this center.', 409);
      }

      const before = {
        name: String(current.name ?? current.centerName ?? ''),
        address: String(current.address ?? current.location ?? ''),
        barangayId: String(current.barangayId ?? ''),
        latitude: current.latitude ?? current.coordinates?.latitude ?? null,
        longitude: current.longitude ?? current.coordinates?.longitude ?? null,
        capacity: Number(current.capacity ?? current.maxCapacity ?? 0),
        facilities: Array.isArray(current.facilities) ? current.facilities : [],
        contactPerson: String(current.contactPerson ?? ''),
        contactNumber: String(current.contactNumber ?? ''),
        status: currentOperationalStatus,
      };
      const after = {
        name,
        address,
        barangayId,
        latitude,
        longitude,
        capacity,
        facilities: [...new Set(facilities.map((value: string) => value.trim()).filter(Boolean))],
        contactPerson,
        contactNumber,
        status,
      };
      const changedFields = Object.keys(after).filter(key => JSON.stringify(before[key as keyof typeof before]) !== JSON.stringify(after[key as keyof typeof after]));
      if (!changedFields.length) return { center: { id: snapshot.id, ...current }, changed: false };

      const updatedAt = new Date();
      const updates = {
        ...after,
        maxCapacity: capacity,
        updatedAt,
      };
      transaction.update(centerRef, updates);

      const redactedFields = changedFields.filter(field => field === 'contactPerson' || field === 'contactNumber');
      const isRedacted = (field: string) => redactedFields.some(redactedField => redactedField === field);
      const auditBefore = Object.fromEntries(changedFields.map(field => [field, isRedacted(field) ? '[redacted]' : before[field as keyof typeof before]]));
      const auditAfter = Object.fromEntries(changedFields.map(field => [field, isRedacted(field) ? '[redacted]' : after[field as keyof typeof after]]));
      logActionInTransaction(transaction, {
        actorId: req.user!.uid,
        actorName: req.user!.name,
        actorRole: req.user!.role,
        actorEmail: req.user!.email,
        action: 'evacuation_center_updated',
        targetType: 'evacuationCenter',
        targetId: centerId,
        details: { displayId: current.displayId ?? null, changedFields, redactedFields, before: auditBefore, after: auditAfter },
      });
      return { center: { id: snapshot.id, ...current, ...updates }, changed: true };
    });

    if (result.changed) invalidateFirestoreReadCache('auditLogs:');
    res.json({ data: result.center });
  } catch (error: any) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error('Update evacuation center failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to update evacuation center.' });
  }
});

export default router;
