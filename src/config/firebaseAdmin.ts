import { initializeApp, cert, applicationDefault, getApps } from 'firebase-admin/app';
import { existsSync } from 'node:fs';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import * as path from 'path';

const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : path.join(__dirname, '../../serviceAccountKey.json');

if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !existsSync(serviceAccountPath)) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS points to a file that does not exist.');
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: existsSync(serviceAccountPath) ? cert(serviceAccountPath) : applicationDefault(),
      ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {}),
    });

export const db = getFirestore(app);
export const auth = getAuth(app);
export const messaging = getMessaging(app);

export default app;
