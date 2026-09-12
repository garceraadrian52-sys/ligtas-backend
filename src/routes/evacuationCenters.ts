import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

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

  const { name, barangayId, capacity, address, latitude, longitude } = req.body ?? {};
  if (!name || !barangayId || capacity === undefined) {
    return res.status(400).json({ error: 'name, barangayId, and capacity are required.' });
  }

  try {
    const now = new Date();
    const docRef = await db.collection('evacuationCenters').add({
      name: String(name).trim(),
      barangayId,
      address: address ?? null,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      capacity: Number(capacity),
      maxCapacity: Number(capacity),
      occupied: 0,
      currentOccupancy: 0,
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