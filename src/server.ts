import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { db } from './config/firebaseAdmin';
import { startNotificationWorkers } from './services/notificationWorker';
import authRoutes from './routes/auth';
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

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (server stays alive):', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (server stays alive):', error);
});

const app = express();
app.use(cors());
app.use(express.json());
app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/reports', reportsRoutes);
app.use('/alerts', alertsRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/evacuation-centers', evacuationCentersRoutes);
app.use('/analytics', analyticsRoutes);
app.use('/map', mapRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/profile', profileRoutes);
app.use('/settings', settingsRoutes);
app.use('/', supportRoutes);
app.use('/audit-logs', auditLogsRoutes);
app.use('/access-requests', accessRequestsRoutes);


app.get('/health', (_req, res) => {
  res.json({ status: 'ok', message: 'LigTAS backend is running' });
});

// Test route — kumpirma na gumagana ang Admin SDK connection
app.get('/test-firestore', async (_req, res) => {
  try {
    const snapshot = await db.collection('barangays').limit(1).get();
    res.json({ connected: true, docsFound: snapshot.size });
  } catch (error) {
    res.status(500).json({ connected: false, error: String(error) });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`LigTAS backend running on http://localhost:${PORT}`);
  startNotificationWorkers();
});