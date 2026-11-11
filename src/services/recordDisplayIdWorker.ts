import { Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import { db } from '../config/firebaseAdmin';
import { assignDisplayIdIfMissing, type DisplayIdModule } from './recordDisplayIds';

let started = false;

function timestampMillis(value: any) {
  return value?.toMillis?.() ?? (value instanceof Date ? value.getTime() : null);
}

function assign(module: Extract<DisplayIdModule, 'reports' | 'households'>, recordRef: DocumentReference) {
  void assignDisplayIdIfMissing(db, module, recordRef).catch(error => {
    console.error(`Assign ${module} display ID failed:`, error);
  });
}

function watchNewRecords(module: Extract<DisplayIdModule, 'reports' | 'households'>) {
  const startedAt = Date.now();
  let initialized = false;
  db.collection(module).where('createdAt', '>=', Timestamp.fromMillis(startedAt)).onSnapshot(snapshot => {
    if (!initialized) {
      initialized = true;
      const createdWhileStarting = snapshot.docs.filter(doc => {
        const createdAt = timestampMillis(doc.data().createdAt);
        return createdAt !== null && createdAt >= startedAt && createdAt <= Date.now() + 60_000;
      });
      for (const doc of createdWhileStarting) {
        const displayId = doc.data().displayId;
        if (typeof displayId !== 'string' || !displayId.trim()) assign(module, doc.ref);
      }
      console.log(`${module} display ID watcher ready. Existing records were left unchanged.`);
      return;
    }

    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;
      const displayId = change.doc.data().displayId;
      if (typeof displayId !== 'string' || !displayId.trim()) assign(module, change.doc.ref);
    }
  }, error => console.error(`${module} display ID watcher failed:`, error));
}

export function startRecordDisplayIdWorkers() {
  if (started) return;
  started = true;
  watchNewRecords('reports');
  watchNewRecords('households');
}
