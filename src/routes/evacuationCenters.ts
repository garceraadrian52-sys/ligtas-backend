import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

import { validText } from '../services/inputValidation';
const router = Router();
router.use(requireAuth, requireOfficial);

// GET /evacuation-centers
router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    const centersRef = db.collection('evacuationCenters');
    const query = req.user!.role === 'LGU_ADMIN'
      ? centersRef
      : centersRef.where('barangayId', '==', req.user!.barangayId);

    const snapshot = await query.get();
    const centers = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json({ data: centers });
  } catch (error) {
    console.error('List evacuation centers failed:', error);
    res.status(500).json({ error: 'Failed to load evacuation centers.' });
  }
});

// POST /evacuation-centers — LGU_ADMIN lang
router.post('/', async (req: AuthenticatedRequest, res) => {
  if (req.user!.role !== 'LGU_ADMIN') {
    return res.status(403).json({ error: 'Only LGU/MDRRMO personnel can register evacuation centers.' });
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
    const docRef = await db.collection('evacuationCenters').add({
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
    });

    const created = await docRef.get();
    res.status(201).json({ data: { id: created.id, ...created.data() } });
  } catch (error) {
    console.error('Create evacuation center failed:', error);
    res.status(500).json({ error: 'Failed to register evacuation center.' });
  }
});

export default router;