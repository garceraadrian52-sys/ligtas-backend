import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getMessaging } from 'firebase-admin/messaging';
import * as path from 'path';

const serviceAccountPath = path.join(__dirname, '../../serviceAccountKey.json');

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert(serviceAccountPath),
    });

export const db = getFirestore(app);
export const auth = getAuth(app);
export const messaging = getMessaging(app);

export default app;