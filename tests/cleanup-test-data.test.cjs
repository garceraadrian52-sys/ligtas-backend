'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const cleanup = require('../scripts/cleanup-test-data.cjs');

function makeSnapshot(collectionName, id, data, childCollections = []) {
  const documentPath = collectionName + '/' + id;
  const reference = {
    id,
    path: documentPath,
    parent: { id: collectionName, path: collectionName },
    listCollections: async () => childCollections,
  };
  return { id, ref: reference, data: () => data };
}

function makeDb(collectionData) {
  const names = Object.keys(collectionData);
  const writes = [];
  const collection = (name) => {
    const documents = collectionData[name] || [];
    return {
      id: name,
      path: name,
      count: () => ({ get: async () => ({ data: () => ({ count: documents.length }) }) }),
      where: (field, operator, value) => ({
        get: async () => {
          const matching = documents.filter((snapshot) => {
            const fieldValue = field.split('.').reduce((item, key) => item && item[key], snapshot.data());
            if (operator === '==') return fieldValue === value;
            if (operator === 'in') return value.includes(fieldValue);
            throw new Error('Unexpected where operator: ' + operator);
          });
          return { docs: matching };
        },
      }),
      select: (...fields) => ({
        orderBy: () => ({
          limit: (limit) => ({ get: async () => {
            const projected = documents.map((snapshot) => ({
              id: snapshot.id,
              ref: snapshot.ref,
              data: () => Object.fromEntries(fields
                .filter((field) => Object.prototype.hasOwnProperty.call(snapshot.data(), field))
                .map((field) => [field, snapshot.data()[field]])),
            }));
            return { docs: projected.slice(0, limit), size: Math.min(projected.length, limit) };
          } }),
        }),
      }),
      orderBy: () => ({
        limit: (limit) => ({ get: async () => ({
          docs: documents.slice(0, limit),
          size: Math.min(documents.length, limit),
        }) }),
      }),
      set: async () => writes.push('set'),
      delete: async () => writes.push('delete'),
      add: async () => writes.push('add'),
    };
  };
  return {
    writes,
    collection,
    listCollections: async () => names.map(collection),
  };
}

test('cleanup is dry-run by default and requires an exact project-scoped delete confirmation', () => {
  assert.equal(cleanup.parseArgs([]).mode, 'dry-run');
  assert.equal(cleanup.parseArgs(['--project', cleanup.EXPECTED_PROJECT]).projectId, cleanup.EXPECTED_PROJECT);
  assert.equal(cleanup.parseArgs(['--backup-only']).mode, 'backup-only');
  assert.throws(() => cleanup.parseArgs(['--dry-run', '--execute']), /Choose only one/);
  assert.throws(() => cleanup.assertDeleteApproval({
    mode: 'execute',
    projectId: cleanup.EXPECTED_PROJECT,
    confirmDelete: 'DELETE-TEST-DATA:wrong-project',
  }, 'a'.repeat(64)), /Deletion requires/);
  const previousKey = process.env.LIGTAS_CLEANUP_BACKUP_KEY;
  try {
    delete process.env.LIGTAS_CLEANUP_BACKUP_KEY;
    assert.throws(() => cleanup.assertDeleteApproval({
      mode: 'execute',
      projectId: cleanup.EXPECTED_PROJECT,
      confirmDelete: 'DELETE-TEST-DATA:' + cleanup.EXPECTED_PROJECT,
      approvePlan: 'a'.repeat(64),
    }, 'a'.repeat(64)), /32-byte Base64 key/);
    process.env.LIGTAS_CLEANUP_BACKUP_KEY = crypto.randomBytes(32).toString('base64');
    assert.throws(() => cleanup.assertDeleteApproval({
      mode: 'execute',
      projectId: cleanup.EXPECTED_PROJECT,
      confirmDelete: 'DELETE-TEST-DATA:' + cleanup.EXPECTED_PROJECT,
      approvePlan: 'b'.repeat(64),
    }, 'a'.repeat(64)), /inventory changed or approval is missing/);
    assert.doesNotThrow(() => cleanup.assertDeleteApproval({
      mode: 'execute',
      projectId: cleanup.EXPECTED_PROJECT,
      confirmDelete: 'DELETE-TEST-DATA:' + cleanup.EXPECTED_PROJECT,
      approvePlan: 'a'.repeat(64),
    }, 'a'.repeat(64)));
  } finally {
    if (previousKey === undefined) delete process.env.LIGTAS_CLEANUP_BACKUP_KEY;
    else process.env.LIGTAS_CLEANUP_BACKUP_KEY = previousKey;
  }
});

test('no-backup deletion waiver requires explicit confirmation and the exact approved isDemo paths', () => {
  const candidates = cleanup.NO_BACKUP_APPROVED_ROOTS.map((path) => ({
    path,
    reason: 'explicit test marker: isDemo=true',
  }));
  const parsed = cleanup.parseArgs([
    '--execute',
    '--no-backup',
    '--confirm-no-backup=' + cleanup.NO_BACKUP_CONFIRMATION,
  ]);
  const approval = {
    ...parsed,
    projectId: cleanup.EXPECTED_PROJECT,
    confirmDelete: 'DELETE-TEST-DATA:' + cleanup.EXPECTED_PROJECT,
    approvePlan: 'a'.repeat(64),
  };

  assert.equal(parsed.noBackup, true);
  assert.throws(() => cleanup.parseArgs(['--execute', '--no-backup']), /requires --confirm-no-backup/);
  assert.throws(() => cleanup.parseArgs([
    '--execute', '--no-backup', '--confirm-no-backup=wrong',
  ]), /requires --confirm-no-backup/);
  assert.throws(() => cleanup.parseArgs([
    '--execute', '--no-backup', '--confirm-no-backup=' + cleanup.NO_BACKUP_CONFIRMATION, '--backup=backup.enc.json',
  ]), /cannot be combined with a backup path/);
  assert.doesNotThrow(() => cleanup.assertDeleteApproval(approval, 'a'.repeat(64), false, candidates));
  assert.throws(() => cleanup.assertDeleteApproval(approval, 'b'.repeat(64), false, candidates), /inventory changed or approval is missing/);
  assert.throws(() => cleanup.assertDeleteApproval(approval, 'a'.repeat(64), false, candidates.slice(1)), /exact 15 approved/);
  const wrongMarker = candidates.map((candidate) => ({ ...candidate }));
  wrongMarker[0].reason = 'explicit test marker: testData=true';
  assert.throws(() => cleanup.assertDeleteApproval(approval, 'a'.repeat(64), false, wrongMarker), /each still marked isDemo=true/);
});

test('backup keys can be piped from a secret manager without placing them in environment variables', async () => {
  const bytes = crypto.randomBytes(32);
  const encoded = bytes.toString('base64');
  const key = await cleanup.readBackupKeyFromStream(Readable.from([Buffer.from(encoded + '\r\n')]));
  assert.deepEqual(key, bytes);
  key.fill(0);
  assert.equal(cleanup.parseArgs(['--backup-only', '--backup-key-stdin']).backupKeyStdin, true);
  assert.throws(() => cleanup.parseArgs(['--backup-key-stdin']), /only valid for backup/);
  await assert.rejects(cleanup.readBackupKeyFromStream(Readable.from(['not-a-key\n'])), /exactly 32 bytes/);
});

test('registered users, configuration, audit records, and ID counters are protected', () => {
  for (const protectedCollection of cleanup.PROTECTED_COLLECTIONS) {
    assert.equal(cleanup.isProtectedPath(protectedCollection + '/record'), true);
    assert.equal(cleanup.isAllowedCandidatePath(protectedCollection + '/record'), false);
  }
  assert.equal(cleanup.isAllowedCandidatePath('reports/report-1'), true);
  assert.equal(cleanup.isAllowedCandidatePath('reports/report-1/notes/note-1'), true);
  assert.equal(cleanup.isAllowedCandidatePath('evacuationCenters/center-1'), false);
  assert.equal(cleanup.isAllowedCandidatePath('unknown/record'), false);
});

test('dry-run inventories only explicit test markers and never requests Firestore writes', async () => {
  const marked = makeSnapshot('reports', 'marked-1', { isTest: true, title: 'Disposable development report' });
  const unmarked = makeSnapshot('reports', 'unmarked-1', { title: 'Test the flood gauge before use' });
  const user = makeSnapshot('users', 'resident-1', { role: 'RESIDENT', email: 'resident@example.test' });
  const counter = makeSnapshot('recordIdCounters', 'reports', { lastIssued: 37 });
  const db = makeDb({
    reports: [marked, unmarked],
    users: [user],
    recordIdCounters: [counter],
    notificationDeliveries: [],
  });

  const inventory = await cleanup.createInventory(db, cleanup.EXPECTED_PROJECT);
  const reportPlan = inventory.candidateCollectionCounts.reports;
  const reviewedPlanHash = cleanup.publicInventory(inventory).planSha256;

  assert.equal(inventory.proposedDocumentCount, 1);
  assert.match(reviewedPlanHash, /^[0-9a-f]{64}$/);
  assert.equal(reportPlan.markedCount, 1);
  assert.equal(reportPlan.reviewCount, 1);
  assert.deepEqual(inventory.candidateRoots.map((root) => root.path), ['reports/marked-1']);
  assert.equal(inventory.protectedCollections.includes('users'), true);
  assert.equal(inventory.protectedCollections.includes('recordIdCounters'), true);
  assert.deepEqual(db.writes, []);
  inventory.candidateDocuments[0].data.title = 'Changed after review';
  assert.notEqual(cleanup.publicInventory(inventory).planSha256, reviewedPlanHash);
});

test('free-text mentioning test is not enough to propose deletion', async () => {
  const report = makeSnapshot('reports', 'ordinary-1', {
    title: 'Test the flood gauge before use',
    description: 'A real report discussing the test location.',
  });
  const db = makeDb({ reports: [report] });
  const inventory = await cleanup.createInventory(db, cleanup.EXPECTED_PROJECT);
  assert.equal(inventory.proposedDocumentCount, 0);
});

test('encrypted backup scope includes review-only records without adding them to deletion candidates', async () => {
  const candidate = makeSnapshot('reports', 'marked-1', { isDemo: true, status: 'pending' });
  const uncertain = makeSnapshot('alerts', 'active-1', { title: 'Flood advisory', status: 'active' });
  const inventory = await cleanup.createInventory(
    makeDb({ reports: [candidate], alerts: [uncertain] }),
    cleanup.EXPECTED_PROJECT,
  );
  const archive = cleanup.makeBackupArchive(inventory);

  assert.equal(inventory.proposedDocumentCount, 1);
  assert.equal(inventory.reviewOnlyDocumentCount, 1);
  assert.equal(archive.documentCount, 2);
  assert.equal(archive.deletionCandidateDocumentCount, 1);
  assert.equal(archive.reviewOnlyDocumentCount, 1);
  assert.deepEqual(archive.documents.map((row) => [row.path, row.scope]), [
    ['alerts/active-1', 'review-only'],
    ['reports/marked-1', 'deletion-candidate'],
  ]);
});

test('detailed review summaries show relationships and consequences while scrubbing contact data', async () => {
  const alert = makeSnapshot('alerts', 'alert-1', {
    title: 'Flood advisory for Balagtas',
    message: 'Call 0917 123 4567; email responder@example.test; address: 123 Main St.',
    category: 'Flood Warning',
    priority: 'High',
    status: 'active',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    locationScope: { type: 'municipality', barangayIds: [] },
  });
  const delivery = makeSnapshot('notificationDeliveries', 'delivery-1', {
    targetId: 'alert-1',
    kind: 'alert',
    state: 'delivered_to_provider',
    title: 'Flood warning at 123 Main Street',
    body: 'Call 0917 123 4567 — LigTAS Test Admin',
  });
  const inventory = await cleanup.createInventory(makeDb({ alerts: [alert], notificationDeliveries: [delivery] }), cleanup.EXPECTED_PROJECT);
  const summary = cleanup.publicInventory(inventory);
  const alertReview = summary.reviewRecords.find((record) => record.path === 'alerts/alert-1');
  const serialized = JSON.stringify(summary);

  assert.match(alertReview.descriptionSummary, /Flood advisory for Balagtas/);
  assert.equal(alertReview.type, 'flood warning');
  assert.match(alertReview.descriptionSummary, /\[phone omitted\]/);
  assert.match(alertReview.descriptionSummary, /\[email omitted\]/);
  assert.match(alertReview.descriptionSummary, /address: \[redacted\]/);
  assert.match(alertReview.potentialDeletionConsequence, /already delivered push notifications cannot be recalled/);
  assert.ok(alertReview.relationships.includes('1 notification delivery record(s) reference this record'));
  assert.equal(serialized.includes('0917 123 4567'), false);
  assert.equal(serialized.includes('responder@example.test'), false);
  assert.equal(serialized.includes('123 Main St'), false);
  assert.equal(serialized.includes('LigTAS Test Admin'), false);
  assert.match(summary.reviewRecords.find((record) => record.path === 'notificationDeliveries/delivery-1').descriptionSummary, /precise location omitted/);

  const reviewedHash = summary.planSha256;
  inventory.reviewRecords.find((record) => record.path === 'alerts/alert-1').descriptionSummary += ' changed';
  assert.notEqual(cleanup.publicInventory(inventory).planSha256, reviewedHash);
});

test('unmarked records remain for review, evacuation centers stay protected, and only linked test notifications are included', async () => {
  const markedReport = makeSnapshot('reports', 'marked-report', { isDemo: true, status: 'pending' });
  const unmarkedReport = makeSnapshot('reports', 'live-report', { status: 'verified' });
  const testLikeAlert = makeSnapshot('alerts', 'alert-1', { title: 'Test announcement', status: 'expired' });
  const center = makeSnapshot('evacuationCenters', 'center-1', { isDemo: true, name: 'Balagtas center', capacity: 100, status: 'active' });
  const sampleOccupancy = makeSnapshot('evacuationRecords', 'sample_record', { status: 'checked_in' });
  const linkedTestDelivery = makeSnapshot('notificationDeliveries', 'delivery-1', {
    targetId: 'marked-report',
    kind: 'report',
    state: 'expired',
  });
  const linkedUnmarkedDelivery = makeSnapshot('notificationDeliveries', 'delivery-2', {
    targetId: 'live-report',
    kind: 'report',
    state: 'expired',
  });
  const db = makeDb({
    reports: [markedReport, unmarkedReport],
    alerts: [testLikeAlert],
    evacuationCenters: [center],
    evacuationRecords: [sampleOccupancy],
    notificationDeliveries: [linkedTestDelivery, linkedUnmarkedDelivery],
  });

  const inventory = await cleanup.createInventory(db, cleanup.EXPECTED_PROJECT);
  const classifications = new Map(inventory.reviewRecords.map((record) => [record.path, record]));

  assert.equal(classifications.get('reports/live-report').classification, 'uncertain');
  assert.equal(classifications.get('alerts/alert-1').classification, 'uncertain');
  assert.equal(classifications.get('alerts/alert-1').testLikeSignal, true);
  assert.equal(classifications.get('evacuationCenters/center-1').classification, 'essential-reference');
  assert.equal(classifications.get('evacuationCenters/center-1').proposedAction, 'preserve');
  assert.equal(classifications.get('evacuationRecords/sample_record').classification, 'uncertain');
  assert.equal(classifications.get('evacuationRecords/sample_record').testLikeSignal, true);
  assert.equal(classifications.get('notificationDeliveries/delivery-1').classification, 'confirmed-test');
  assert.equal(classifications.get('notificationDeliveries/delivery-2').classification, 'uncertain');
  assert.deepEqual(inventory.candidateRoots.map((root) => root.path).sort(), [
    'notificationDeliveries/delivery-1',
    'reports/marked-report',
  ]);
  assert.equal(inventory.linkedNotificationCount, 1);
  assert.equal(inventory.notificationSummary.documentCount, 2);
  assert.equal(inventory.protectedCollections.includes('evacuationCenters'), true);
});

test('dry-run includes subcollection counts under a marked disposable record', async () => {
  const child = makeSnapshot('reports/marked-1/notes', 'note-1', { note: 'test artifact' });
  const childCollection = {
    id: 'notes',
    path: 'reports/marked-1/notes',
    orderBy: () => ({
      limit: () => ({ get: async () => ({ docs: [child], size: 1 }) }),
    }),
  };
  const parent = makeSnapshot('reports', 'marked-1', { testData: true }, [childCollection]);
  const db = makeDb({ reports: [parent] });
  const inventory = await cleanup.createInventory(db, cleanup.EXPECTED_PROJECT);
  assert.equal(inventory.proposedDocumentCount, 2);
  assert.deepEqual(inventory.deletionCollectionCounts, {
    reports: 1,
    'reports/marked-1/notes': 1,
  });
});

test('attachment review detects shared Cloudinary objects and likely orphaned media without exposing URLs', () => {
  const sharedUrl = 'https://res.cloudinary.com/example/image/upload/v1/report-1.jpg?token=private-value';
  const onlyProposedUrl = 'https://res.cloudinary.com/example/image/upload/v1/report-2.jpg?token=private-value';
  const proposed = makeSnapshot('reports', 'marked-1', {
    isDemo: true,
    photoUrl: sharedUrl,
    attachments: [{ url: sharedUrl }],
  });
  const retained = makeSnapshot('reports', 'retained-1', { photoURL: sharedUrl });
  const proposedOnly = makeSnapshot('reports', 'marked-2', { isTest: true, photoUrl: onlyProposedUrl });
  const collectionMap = new Map([['reports', [proposed, retained, proposedOnly]]]);
  const candidateMap = new Map([
    [proposed.ref.path, true],
    [proposedOnly.ref.path, true],
  ]);
  const summary = cleanup.summarizeAttachments(collectionMap, candidateMap);

  assert.equal(summary.proposedReferenceCount, 3);
  assert.equal(summary.uniqueProposedObjects, 2);
  assert.equal(summary.referencedByRetainedOperationalRecords, 1);
  assert.equal(summary.likelyOrphanedIfDeleted, 1);
  assert.equal(summary.providers.cloudinary, 3);
  assert.equal(JSON.stringify(summary).includes('report-1.jpg'), false);
  assert.equal(JSON.stringify(summary).includes('private-value'), false);
});

test('profile photo references are checked without exposing profile data or image URLs', async () => {
  const imageUrl = 'https://res.cloudinary.com/example/image/upload/v1/profile-photo.jpg';
  const proposed = makeSnapshot('reports', 'marked-1', { isDemo: true, photoUrl: imageUrl });
  const resident = makeSnapshot('users', 'resident-1', {
    photoURL: imageUrl,
    email: 'private@example.test',
    phoneNumber: 'private-phone',
  });
  const inventory = await cleanup.createInventory(makeDb({ reports: [proposed], users: [resident] }), cleanup.EXPECTED_PROJECT);
  const summary = cleanup.publicInventory(inventory);

  assert.equal(summary.attachmentSummary.referencedByPreservedProfilePictures, 1);
  assert.equal(summary.attachmentSummary.preservedProfilePhotoReferenceCount, 1);
  assert.equal(summary.attachmentSummary.likelyOrphanedIfDeleted, 0);
  assert.equal(JSON.stringify(summary).includes(imageUrl), false);
  assert.equal(JSON.stringify(summary).includes('private@example.test'), false);
  assert.equal(JSON.stringify(summary).includes('private-phone'), false);
});

test('optional media-only scan checks all retained roots and descendants without exposing raw URLs or profile data', async () => {
  const imageUrl = 'https://res.cloudinary.com/example/image/upload/v1/shared-cleanup-object.jpg?token=private-value';
  const proposed = makeSnapshot('reports', 'marked-1', { isDemo: true, photoUrl: imageUrl });
  const household = makeSnapshot('households', 'household-1', { attachments: [{ url: imageUrl }] });
  const resident = makeSnapshot('users', 'resident-uid', {
    photoURL: imageUrl,
    email: 'private@example.test',
    phoneNumber: 'private-phone',
  });
  const inventory = await cleanup.createInventory(
    makeDb({ reports: [proposed], households: [household], users: [resident] }),
    cleanup.EXPECTED_PROJECT,
    new Date('2026-11-09T12:00:00.000Z'),
    { scanMediaReferences: true },
  );
  const report = cleanup.publicInventory(inventory);

  assert.equal(report.attachmentSummary.mediaReferenceScan.status, 'complete');
  assert.equal(report.attachmentSummary.referencedByRetainedOperationalRecords, 1);
  assert.equal(report.attachmentSummary.referencedByPreservedProfilePictures, 1);
  assert.equal(report.attachmentSummary.likelyOrphanedIfDeleted, 0);
  assert.deepEqual(report.attachmentSummary.objectUsage[0].retainedOperationalRecordPaths, ['households/household-1']);
  assert.equal(JSON.stringify(report).includes(imageUrl), false);
  assert.equal(JSON.stringify(report).includes('private@example.test'), false);
  assert.equal(JSON.stringify(report).includes('private-phone'), false);
});

test('encrypted backup verifies, round-trips, and rejects the wrong key', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ligtas-cleanup-test-'));
  const key = crypto.randomBytes(32);
  const timestamp = new Date('2026-11-09T12:00:00.000Z');
  class Timestamp {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
    toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
  }
  const original = {
    title: 'Test alert',
    createdAt: new Timestamp(1794225600, 123000000),
    values: [1, null, true],
    metadata: { language: 'en' },
  };
  const encoded = cleanup.encodeFirestoreValue(original);
  const decoded = cleanup.decodeFirestoreValue(encoded, {
    Timestamp,
    GeoPoint: class GeoPoint {},
    db: { doc: (documentPath) => ({ path: documentPath }) },
  });
  assert.equal(decoded.createdAt.toMillis(), original.createdAt.toMillis());
  assert.deepEqual(decoded.values, original.values);

  const inventory = {
    projectId: cleanup.EXPECTED_PROJECT,
    generatedAt: timestamp.toISOString(),
    proposedDocumentCount: 1,
    candidateDocuments: [{
      path: 'alerts/alert-1',
      collectionPath: 'alerts',
      reason: 'explicit test marker: isTest=true',
      data: original,
    }],
  };
  inventory.reviewBackupDocuments = [
    ...inventory.candidateDocuments,
    { path: 'alerts/review-only', collectionPath: 'alerts', reason: 'manual review copy', data: { status: 'active' } },
  ];
  const backupPath = path.join(temporaryDirectory, 'backup.enc.json');
  const result = await cleanup.writeVerifiedBackup(inventory, backupPath, key);
  assert.equal(result.documentCount, 2);
  assert.equal(result.deletionCandidateDocumentCount, 1);
  assert.equal(result.reviewOnlyDocumentCount, 1);
  assert.match(result.restoreReadiness, /Firestore restore not run/);
  assert.equal((await fs.stat(backupPath)).isFile(), true);
  await assert.rejects(
    fs.readFile(backupPath).then((buffer) => cleanup.decryptBackup(buffer, crypto.randomBytes(32), cleanup.EXPECTED_PROJECT)),
  );
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('restore is idempotent and refuses to overwrite changed live records', async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ligtas-cleanup-restore-'));
  const key = crypto.randomBytes(32);
  const { Timestamp } = require('firebase-admin/firestore');
  const original = { title: 'Marked test report', createdAt: Timestamp.fromMillis(1794225600123) };
  const inventory = {
    projectId: cleanup.EXPECTED_PROJECT,
    generatedAt: '2026-11-09T12:00:00.000Z',
    proposedDocumentCount: 1,
    candidateDocuments: [{
      path: 'reports/report-1',
      collectionPath: 'reports',
      reason: 'explicit test marker: isTest=true',
      data: original,
    }],
  };
  inventory.reviewBackupDocuments = [
    ...inventory.candidateDocuments,
    { path: 'alerts/review-only', collectionPath: 'alerts', reason: 'manual review copy', data: { status: 'active' } },
  ];
  const backupPath = path.join(temporaryDirectory, 'backup.enc.json');
  await cleanup.writeVerifiedBackup(inventory, backupPath, key);
  const records = new Map();
  const db = {
    doc: (documentPath) => ({
      get: async () => records.has(documentPath)
        ? { exists: true, data: () => records.get(documentPath) }
        : { exists: false },
      create: async (data) => {
        if (records.has(documentPath)) throw new Error('already exists');
        records.set(documentPath, data);
      },
    }),
  };

  assert.deepEqual(await cleanup.restoreBackup(db, backupPath, key, cleanup.EXPECTED_PROJECT), {
    restored: 2,
    alreadyPresent: 0,
  });
  assert.deepEqual(await cleanup.restoreBackup(db, backupPath, key, cleanup.EXPECTED_PROJECT), {
    restored: 0,
    alreadyPresent: 2,
  });
  records.set('reports/report-1', { title: 'different record' });
  await assert.rejects(
    cleanup.restoreBackup(db, backupPath, key, cleanup.EXPECTED_PROJECT),
    /already exists with different data/,
  );
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

test('backup creation refuses records with credential-like fields', () => {
  assert.throws(() => cleanup.assertNoSensitiveFields({ nested: { accessToken: 'must not be backed up' } }), /sensitive field/);
  assert.throws(() => cleanup.assertNoSensitiveFields({ password: 'must not be backed up' }), /sensitive field/);
});

test('attachment paths are counted without printing their values or scheduling Storage deletion', async () => {
  const report = makeSnapshot('reports', 'marked-1', {
    testData: true,
    attachment: { storagePath: 'private/object/name.jpg' },
  });
  const db = makeDb({ reports: [report] });
  const inventory = await cleanup.createInventory(db, cleanup.EXPECTED_PROJECT);
  const summary = cleanup.publicInventory(inventory);
  assert.equal(summary.attachmentReferenceCount, 1);
  assert.match(summary.storageObjectsAction, /preserved/);
  assert.equal(JSON.stringify(summary).includes('private/object/name.jpg'), false);
});
