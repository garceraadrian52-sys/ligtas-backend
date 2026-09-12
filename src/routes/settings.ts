import { Router } from 'express';
import { requireAuth, requireOfficial, type AuthenticatedRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth, requireOfficial);

// POST /settings/backup — placeholder muna, linawin sa team kung ano dapat gawin nito
router.post('/backup', async (req: AuthenticatedRequest, res) => {
  res.json({ data: { status: 'not_implemented', message: 'Backup feature is not yet configured.' } });
});

export default router;