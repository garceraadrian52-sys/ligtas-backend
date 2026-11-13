import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { db } from './config/firebaseAdmin';
import { areNotificationWorkersStarted, startNotificationWorkers } from './services/notificationWorker';
import { startRecordDisplayIdWorkers } from './services/recordDisplayIdWorker';
import authRoutes from './routes/auth';
import residentAuthRoutes from './routes/residentAuth';
import { auditFailures } from './middleware/auditFailures';
import usersRoutes from './routes/users';
import reportsRoutes from './routes/reports';
import alertsRoutes from './routes/alerts';
import dashboardRoutes from './routes/dashboard';
import evacuationCentersRoutes from './routes/evacuationCenters';
import analyticsRoutes from './routes/analytics';
import mapRoutes from './routes/map';
import notificationsRoutes from './routes/notifications';
import profileRoutes from './routes/profile';
import settingsRoutes from './routes/settings';
import supportRoutes from './routes/support';
import auditLogsRoutes from './routes/auditLogs';
import accessRequestsRoutes from './routes/accessRequests';
import householdsRoutes from './routes/households';
import { requireAuth, requireOfficial } from './middleware/auth';

import { notFound, errorHandler } from './middleware/errorHandler';

export const app = express();
app.disable('x-powered-by');
const allowedOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(allowedOrigins.length
  ? cors({ origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Origin is not allowed by CORS.'));
    } })
  : cors());
// Profile images are resized in the web client before upload and stored inline
// with the user's Firestore profile. Keep the request limit bounded.
app.use(express.json({ limit: '512kb' }));
app.use(auditFailures);
app.use('/auth', authRoutes);
app.use('/auth/resident', residentAuthRoutes);
app.use('/users', usersRoutes);
app.use('/reports', reportsRoutes);
app.use('/alerts', alertsRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/evacuation-centers', evacuationCentersRoutes);
app.use('/households', householdsRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/map', mapRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/profile', profileRoutes);
app.use('/settings', settingsRoutes);
app.use('/', supportRoutes);
app.use('/audit-logs', auditLogsRoutes);
app.use('/access-requests', accessRequestsRoutes);


app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'LigTAS backend is running',
    capabilities: { residentReportSubmission: true, reportRouting: 'incident_coordinates_v1' },
    database: 'not_checked',
    systemVersion: process.env.LIGTAS_SYSTEM_VERSION || '1.0',
    notificationWorkersEnabled: areNotificationWorkersStarted(),
  });
});

// Test route — kumpirma na gumagana ang Admin SDK connection
app.get('/test-firestore', requireAuth, requireOfficial, async (_req, res) => {
  try {
    const snapshot = await db.collection('barangays').limit(1).get();
    res.json({ connected: true, docsFound: snapshot.size });
  } catch (error) {
    res.status(503).json({ connected: false, error: 'Firestore connection could not be verified.' });
  }
});

app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  // Bind to all interfaces so managed hosts (and LAN devices) can reach the API.
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`LigTAS backend running on http://${host}:${port}`);
    startRecordDisplayIdWorkers();
    if (process.env.ENABLE_NOTIFICATION_WORKERS === 'true') {
      startNotificationWorkers();
    } else {
      console.log('Notification workers disabled. HTTP health does not verify Firebase credentials.');
    }
  });
}
