import { Router } from 'express';
import { db } from '../config/firebaseAdmin';
import boundary from '../config/balagtasBoundary.json';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';
import { isMunicipalityAdmin } from '../services/roles';
import { listReports } from '../services/reportReads';
import { respondToFirestoreResourceExhausted } from '../services/firestoreErrors';
import { isInBalagtas } from '../services/balagtasMonitoring';

const router = Router();
router.use(requireAuth, requireOfficial);

const addressSearchCache = new Map<string, { expiresAt: number; features: any[] }>();
const addressSearchCacheTtl = 60 * 60 * 1000;
const mapBounds = boundary.reduce((bounds, point) => ({
  minLatitude: Math.min(bounds.minLatitude, point.latitude),
  minLongitude: Math.min(bounds.minLongitude, point.longitude),
  maxLatitude: Math.max(bounds.maxLatitude, point.latitude),
  maxLongitude: Math.max(bounds.maxLongitude, point.longitude),
}), { minLatitude: Infinity, minLongitude: Infinity, maxLatitude: -Infinity, maxLongitude: -Infinity });

// GET /map/address-suggestions?q=...
router.get('/address-suggestions', async (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ') : '';
  if (query.length < 3 || query.length > 120) {
    return res.status(400).json({ error: 'Enter an address with 3 to 120 characters.' });
  }

  const cacheKey = query.toLocaleLowerCase();
  const cached = addressSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json({ data: { features: cached.features } });
  if (cached) addressSearchCache.delete(cacheKey);

  try {
    const endpoint = new URL(process.env.PLACE_SEARCH_API_URL || 'https://photon.komoot.io/api/');
    endpoint.search = new URLSearchParams({
      q: query,
      bbox: [mapBounds.minLongitude, mapBounds.minLatitude, mapBounds.maxLongitude, mapBounds.maxLatitude].join(','),
      countrycode: 'PH',
      lang: 'en',
      limit: '8',
      lat: '14.8187',
      lon: '120.9054',
      zoom: '13',
      location_bias_scale: '0.4',
    }).toString();

    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/geo+json, application/json',
        'User-Agent': 'LigTAS-Web/1.0 (Balagtas evacuation center address search)',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return res.status(503).json({ error: 'Address suggestions are temporarily unavailable.' });

    const result: any = await response.json();
    const features = (Array.isArray(result?.features) ? result.features : []).filter((feature: any) => {
      const coordinates = feature?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
      const [longitude, latitude] = coordinates;
      return typeof latitude === 'number' && typeof longitude === 'number'
        && isInBalagtas({ latitude, longitude });
    }).slice(0, 8);

    addressSearchCache.set(cacheKey, { expiresAt: Date.now() + addressSearchCacheTtl, features });
    if (addressSearchCache.size > 500) addressSearchCache.delete(addressSearchCache.keys().next().value!);
    return res.json({ data: { features } });
  } catch {
    return res.status(503).json({ error: 'Address suggestions are temporarily unavailable.' });
  }
});

// GET /map/monitoring
router.get('/monitoring', async (req: AuthenticatedRequest, res) => {
  try {
    const isLguAdmin = isMunicipalityAdmin(req.user!.role);
    const barangayId = req.user!.barangayId;

    const roadsRef = db.collection('roadConditions');
    const roadsQuery = isLguAdmin ? roadsRef : roadsRef.where('barangayId', '==', barangayId);
    const roadsSnapshot = await roadsQuery.get();

    const centersRef = db.collection('evacuationCenters');
    const centersQuery = isLguAdmin ? centersRef : centersRef.where('barangayId', '==', barangayId);
    const centersSnapshot = await centersQuery.get();

    const reports = await listReports(isLguAdmin ? null : barangayId);
    const floodReports = reports.filter(report => {
      return report.type === 'flood' || report.reportType === 'flood';
    }).map(report => {
      return { id: report.id, location: report.location, description: report.description,
        status: report.status, verification: report.verification, latitude: report.latitude,
        longitude: report.longitude, locationPoint: report.locationPoint, coordinates: report.coordinates };
    });
    res.json({
      data: {
        floodReports,
        roadConditions: roadsSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
        evacuationCenters: centersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      },
    });
  } catch (error) {
    console.error('Map monitoring load failed:', error);
    if (respondToFirestoreResourceExhausted(res, error)) return;
    res.status(500).json({ error: 'Failed to load map monitoring data.' });
  }
});

export default router;
