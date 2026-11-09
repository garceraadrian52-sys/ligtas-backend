'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXPECTED_PROJECT = 'ligtas-d7a4c';
const NO_BACKUP_CONFIRMATION = 'NO-BACKUP-IRREVERSIBLE:ligtas-d7a4c';
const NO_BACKUP_APPROVED_ROOTS = Object.freeze([
  'reports/capstone_simulation_flood_01',
  'reports/capstone_simulation_flood_03',
  'reports/capstone_simulation_flood_05',
  'reports/capstone_simulation_flood_07',
  'reports/capstone_simulation_flood_09',
  'reports/capstone_simulation_road_02',
  'reports/capstone_simulation_road_04',
  'reports/capstone_simulation_road_06',
  'reports/capstone_simulation_road_08',
  'reports/capstone_simulation_road_10',
  'roadConditions/capstone_simulation_road_02',
  'roadConditions/capstone_simulation_road_04',
  'roadConditions/capstone_simulation_road_06',
  'roadConditions/capstone_simulation_road_08',
  'roadConditions/capstone_simulation_road_10',
]);
const FORMAT = 'ligtas-cleanup-backup-v1';
const ENCRYPTED_FORMAT = 'ligtas-cleanup-encrypted-backup-v1';
const PAGE_SIZE = 200;

const CANDIDATE_COLLECTIONS = Object.freeze([
  'reports',
  'roadConditions',
  'alerts',
  'evacuationRecords',
  'evacuationCenters',
  'activeEvacuations',
  'accessRequests',
  'householdRequests',
  'notificationDeliveries',
]);

const PROTECTED_COLLECTIONS = Object.freeze([
  'users',
  'userSettings',
  'systemSettings',
  'barangays',
  'emergencyContacts',
  'auditLogs',
  'recordIdCounters',
  'households',
  'evacuationCenters',
]);
const ESSENTIAL_REFERENCE_COLLECTIONS = Object.freeze([
  ...PROTECTED_COLLECTIONS,
  'reportTypes',
  'severities',
]);

const TEST_MARKERS = Object.freeze([
  { field: 'isTest', value: true, label: 'isTest=true' },
  { field: 'testData', value: true, label: 'testData=true' },
  { field: 'testOnly', value: true, label: 'testOnly=true' },
  { field: 'isDemo', value: true, label: 'isDemo=true' },
  { field: 'metadata.isTest', value: true, label: 'metadata.isTest=true' },
  { field: 'metadata.testData', value: true, label: 'metadata.testData=true' },
  { field: 'dataClass', value: 'test', label: 'dataClass=test' },
  { field: 'environment', value: 'test', label: 'environment=test' },
  { field: 'environment', value: 'demo', label: 'environment=demo' },
]);

const SENSITIVE_FIELD = /(password|secret|private.?key|service.?account|api.?key|token)/i;
const ATTACHMENT_FIELD = /(storage.?path|attachment.?path|image.?path|photo.?path|file.?path|attachment.?url|image.?url|photo.?url|file.?url|avatar.?url|profile.?picture|logo.?url|banner.?url)/i;
const MEDIA_FIELD_PROJECTION = Object.freeze([
  'storagePath', 'attachmentPath', 'imagePath', 'photoPath', 'filePath',
  'attachmentUrl', 'imageUrl', 'imageURL', 'photoUrl', 'photoURL', 'fileUrl',
  'attachments', 'photos', 'photoUrls', 'imageUrls', 'images', 'image', 'media', 'evidence',
  'avatarUrl', 'profilePicture', 'logoUrl', 'bannerUrl',
]);

function isProtectedPath(documentPath) {
  const root = String(documentPath || '').split('/')[0];
  return PROTECTED_COLLECTIONS.includes(root);
}

function isAllowedCandidatePath(documentPath) {
  const parts = String(documentPath || '').split('/');
  return parts.length >= 2
    && parts.length % 2 === 0
    && CANDIDATE_COLLECTIONS.includes(parts[0])
    && !isProtectedPath(documentPath);
}

function assertNoSensitiveFields(value, currentPath = '') {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSensitiveFields(child, currentPath + '[' + index + ']'));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_FIELD.test(key)) {
      throw new Error('Backup blocked because a candidate document contains a sensitive field name at ' + (currentPath ? currentPath + '.' : '') + key + '.');
    }
    assertNoSensitiveFields(child, currentPath ? currentPath + '.' + key : key);
  }
}

function encodeFirestoreValue(value) {
  if (value === null) return ['null'];
  if (typeof value === 'string' || typeof value === 'boolean') return ['scalar', value];
  if (typeof value === 'number') return Number.isFinite(value) ? ['scalar', value] : ['number', String(value)];
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('Backup contains a value that cannot be restored safely.');
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (typeof value.toMillis === 'function' && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
    return ['timestamp', value.seconds, value.nanoseconds];
  }
  if (value.constructor && value.constructor.name === 'DocumentReference' && typeof value.path === 'string') {
    return ['reference', value.path];
  }
  if (value.constructor && value.constructor.name === 'GeoPoint'
    && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
    return ['geo', value.latitude, value.longitude];
  }
  if (Array.isArray(value)) return ['array', value.map(encodeFirestoreValue)];
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Backup contains an unsupported Firestore value type.');
  }
  const entries = Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, encodeFirestoreValue(child)]);
  return ['map', entries];
}

function decodeFirestoreValue(encoded, factories) {
  if (!Array.isArray(encoded) || typeof encoded[0] !== 'string') throw new Error('Backup contains an invalid encoded value.');
  switch (encoded[0]) {
    case 'null': return null;
    case 'scalar': return encoded[1];
    case 'number':
      if (!['NaN', 'Infinity', '-Infinity'].includes(encoded[1])) throw new Error('Backup contains an invalid number.');
      return encoded[1] === 'NaN' ? NaN : encoded[1] === 'Infinity' ? Infinity : -Infinity;
    case 'bytes': return Buffer.from(encoded[1], 'base64');
    case 'date': return new Date(encoded[1]);
    case 'timestamp': return new factories.Timestamp(encoded[1], encoded[2]);
    case 'reference': return factories.db.doc(encoded[1]);
    case 'geo': return new factories.GeoPoint(encoded[1], encoded[2]);
    case 'array': return encoded[1].map((child) => decodeFirestoreValue(child, factories));
    case 'map':
      return Object.fromEntries(encoded[1].map(([key, child]) => [key, decodeFirestoreValue(child, factories)]));
    default: throw new Error('Backup contains an unknown value encoding.');
  }
}

function validateEncodedValue(encoded) {
  const fakeFactories = {
    Timestamp: class Timestamp { constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; } },
    GeoPoint: class GeoPoint { constructor(latitude, longitude) { this.latitude = latitude; this.longitude = longitude; } },
    db: { doc: (documentPath) => ({ path: documentPath }) },
  };
  decodeFirestoreValue(encoded, fakeFactories);
}

function parseArgs(argv) {
  const options = { mode: 'dry-run' };
  const requestedModes = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = (name) => {
      const inlinePrefix = name + '=';
      if (argument.startsWith(inlinePrefix)) return argument.slice(inlinePrefix.length);
      if (argument === name && argv[index + 1]) return argv[++index];
      throw new Error(name + ' requires a value.');
    };
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--dry-run') { options.mode = 'dry-run'; requestedModes.add('dry-run'); }
    else if (argument === '--execute') { options.mode = 'execute'; requestedModes.add('execute'); }
    else if (argument === '--restore') { options.mode = 'restore'; requestedModes.add('restore'); }
    else if (argument === '--backup-only') { options.mode = 'backup-only'; requestedModes.add('backup-only'); }
    else if (argument === '--verify-backup') options.verifyBackup = takeValue(argument);
    else if (argument.startsWith('--project=') || argument === '--project') options.projectId = takeValue('--project');
    else if (argument.startsWith('--confirm-delete=') || argument === '--confirm-delete') options.confirmDelete = takeValue('--confirm-delete');
    else if (argument.startsWith('--approve-plan=') || argument === '--approve-plan') options.approvePlan = takeValue('--approve-plan');
    else if (argument.startsWith('--confirm-restore=') || argument === '--confirm-restore') options.confirmRestore = takeValue('--confirm-restore');
    else if (argument.startsWith('--backup=') || argument === '--backup') options.backupPath = takeValue('--backup');
    else if (argument === '--backup-key-stdin') options.backupKeyStdin = true;
    else if (argument === '--no-backup') options.noBackup = true;
    else if (argument.startsWith('--confirm-no-backup=') || argument === '--confirm-no-backup') options.confirmNoBackup = takeValue('--confirm-no-backup');
    else if (argument === '--scan-media-references') options.scanMediaReferences = true;
    else if (argument.startsWith('--audit-dir=') || argument === '--audit-dir') options.auditDir = takeValue('--audit-dir');
    else throw new Error('Unsupported option: ' + argument);
  }
  if (requestedModes.size > 1) throw new Error('Choose only one of --dry-run, --backup-only, --execute, or --restore.');
  if (options.mode === 'execute' && options.verifyBackup) throw new Error('--verify-backup cannot be combined with --execute.');
  if (options.noBackup && options.mode !== 'execute') throw new Error('--no-backup is only valid with --execute.');
  if (options.confirmNoBackup && !options.noBackup) throw new Error('--confirm-no-backup requires --no-backup.');
  if (options.noBackup && (options.backupPath || options.backupKeyStdin)) {
    throw new Error('--no-backup cannot be combined with a backup path or backup-key input.');
  }
  if (options.noBackup && options.confirmNoBackup !== NO_BACKUP_CONFIRMATION) {
    throw new Error('--no-backup requires --confirm-no-backup=' + NO_BACKUP_CONFIRMATION + '.');
  }
  if (options.backupKeyStdin && !(options.mode === 'execute' || options.mode === 'restore' || options.mode === 'backup-only' || options.verifyBackup)) {
    throw new Error('--backup-key-stdin is only valid for backup, verify-backup, restore, or execute operations.');
  }
  return options;
}

function assertProject(projectId) {
  if (projectId !== EXPECTED_PROJECT) {
    throw new Error('Set --project=' + EXPECTED_PROJECT + ' explicitly. No database was changed.');
  }
}

function assertExactNoBackupScope(candidateRoots) {
  if (!Array.isArray(candidateRoots) || candidateRoots.length !== NO_BACKUP_APPROVED_ROOTS.length) {
    throw new Error('No-backup deletion is restricted to the exact 15 approved simulation records. No database was changed.');
  }
  if (candidateRoots.some((root) => !root || typeof root.path !== 'string')) {
    throw new Error('No-backup deletion received an invalid candidate path list. No database was changed.');
  }
  const roots = candidateRoots.slice().sort((left, right) => left.path.localeCompare(right.path));
  const approved = NO_BACKUP_APPROVED_ROOTS.slice().sort();
  if (roots.some((root, index) => root.path !== approved[index] || root.reason !== 'explicit test marker: isDemo=true')) {
    throw new Error('No-backup deletion requires the exact approved paths, each still marked isDemo=true. No database was changed.');
  }
}

function assertDeleteApproval(
  options,
  currentPlanHash,
  backupKeyAvailable = Boolean(process.env.LIGTAS_CLEANUP_BACKUP_KEY),
  candidateRoots,
) {
  assertProject(options.projectId);
  if (options.mode !== 'execute' || options.confirmDelete !== 'DELETE-TEST-DATA:' + EXPECTED_PROJECT) {
    throw new Error('Deletion requires --execute and --confirm-delete=DELETE-TEST-DATA:' + EXPECTED_PROJECT + '. No database was changed.');
  }
  if (!currentPlanHash || options.approvePlan !== currentPlanHash) {
    throw new Error('Deletion requires --approve-plan=<hash> matching the reviewed dry-run inventory. The inventory changed or approval is missing; no database was changed.');
  }
  if (options.noBackup) {
    if (options.confirmNoBackup !== NO_BACKUP_CONFIRMATION) {
      throw new Error('No-backup deletion requires explicit --confirm-no-backup=' + NO_BACKUP_CONFIRMATION + '. No database was changed.');
    }
    assertExactNoBackupScope(candidateRoots);
  } else if (!backupKeyAvailable) {
    throw new Error('Provide a private 32-byte Base64 key through the approved secret store or LIGTAS_CLEANUP_BACKUP_KEY. No database was changed.');
  }
}

function getBackupKey(value = process.env.LIGTAS_CLEANUP_BACKUP_KEY) {
  if (!value) throw new Error('No backup key was provided by the approved secret store or LIGTAS_CLEANUP_BACKUP_KEY.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('LIGTAS_CLEANUP_BACKUP_KEY must decode to exactly 32 bytes.');
  return key;
}

async function readBackupKeyFromStream(input = process.stdin) {
  const chunks = [];
  let byteCount = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.length;
    if (byteCount > 512) throw new Error('Backup key input is too large.');
    chunks.push(bytes);
  }
  const encoded = Buffer.concat(chunks).toString('ascii').trim();
  if (!encoded) throw new Error('No backup key was received on stdin.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    key.fill(0);
    throw new Error('Backup key input must decode to exactly 32 bytes.');
  }
  return key;
}

async function getBackupKeyForOptions(options) {
  return options.backupKeyStdin ? readBackupKeyFromStream() : getBackupKey();
}

function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateBackupArchive(archive, expectedProject) {
  if (!archive || archive.format !== FORMAT || archive.projectId !== expectedProject || !Array.isArray(archive.documents)) {
    throw new Error('Backup format or project ID is invalid.');
  }
  if (archive.documentCount !== archive.documents.length) throw new Error('Backup document count does not match the archive.');
  if (Number.isInteger(archive.deletionCandidateDocumentCount)
    && Number.isInteger(archive.reviewOnlyDocumentCount)
    && archive.deletionCandidateDocumentCount + archive.reviewOnlyDocumentCount !== archive.documentCount) {
    throw new Error('Backup scope counts do not match the archive.');
  }
  const seenPaths = new Set();
  for (const row of archive.documents) {
    if (!row || typeof row.path !== 'string' || !isAllowedCandidatePath(row.path) || seenPaths.has(row.path)) {
      throw new Error('Backup includes a protected, duplicate, or invalid document path.');
    }
    if (row.scope !== undefined && !['deletion-candidate', 'review-only'].includes(row.scope)) {
      throw new Error('Backup includes an invalid review scope.');
    }
    seenPaths.add(row.path);
    validateEncodedValue(row.data);
  }
  return { projectId: archive.projectId, documentCount: archive.documentCount };
}

function encryptBackup(archive, key) {
  const plaintext = Buffer.from(JSON.stringify(archive), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.from(JSON.stringify({
    format: ENCRYPTED_FORMAT,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    plaintextSha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
    ciphertext: ciphertext.toString('base64'),
  }), 'utf8');
}

function decryptBackup(encryptedBuffer, key, expectedProject) {
  const envelope = JSON.parse(Buffer.from(encryptedBuffer).toString('utf8'));
  if (envelope.format !== ENCRYPTED_FORMAT || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('Encrypted backup format is invalid.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  const digest = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (digest !== envelope.plaintextSha256) throw new Error('Backup integrity check failed.');
  const archive = JSON.parse(plaintext.toString('utf8'));
  validateBackupArchive(archive, expectedProject);
  return archive;
}

async function countDocuments(collectionRef) {
  const result = await collectionRef.count().get();
  const count = result.data().count;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Firestore returned an invalid aggregate count.');
  return count;
}

function fieldValue(data, field) {
  return field.split('.').reduce((value, key) => value && value[key], data);
}

function explicitTestMarkerReasons(data) {
  return TEST_MARKERS
    .filter((marker) => fieldValue(data, marker.field) === marker.value)
    .map((marker) => marker.label);
}

async function readCollectionDocuments(collectionRef) {
  const documents = [];
  let cursor;
  while (true) {
    let query = collectionRef.orderBy('__name__').limit(PAGE_SIZE);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    documents.push(...page.docs);
    if (page.size < PAGE_SIZE) break;
    cursor = page.docs[page.docs.length - 1];
  }
  return documents;
}

function isWithinCandidateRoot(documentPath, candidateRootPaths) {
  return candidateRootPaths.some((candidatePath) => documentPath === candidatePath
    || documentPath.startsWith(candidatePath + '/'));
}

function safeMediaReferencePath(documentPath) {
  const parts = String(documentPath || '').split('/');
  return parts[0] === 'users' && parts.length >= 2
    ? 'users/{uid}' + (parts.length > 2 ? '/…' : '')
    : documentPath;
}

async function scanRetainedMediaReferences(db, rootNames, documentsByCollection, candidateRootPaths) {
  const references = [];
  const profileDocuments = [];
  const scannedCollections = [];
  let scannedDocumentCount = 0;

  const visitDocument = async (snapshot, rootName) => {
    const documentPath = snapshot.ref.path;
    if (isWithinCandidateRoot(documentPath, candidateRootPaths)) return;
    scannedDocumentCount += 1;
    if (rootName === 'users' && documentPath.split('/').length === 2) profileDocuments.push(snapshot);
    for (const rawReference of extractAttachmentReferences(snapshot.data() || {})) {
      references.push({
        rawReference,
        path: documentPath,
        safePath: safeMediaReferencePath(documentPath),
        rootCollection: rootName,
      });
    }

    for (const childCollection of await snapshot.ref.listCollections()) {
      const projectedCollection = typeof childCollection.select === 'function'
        ? childCollection.select(...MEDIA_FIELD_PROJECTION)
        : childCollection;
      let cursor;
      while (true) {
        let query = projectedCollection.orderBy('__name__').limit(PAGE_SIZE);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        for (const childDocument of page.docs) await visitDocument(childDocument, rootName);
        if (page.size < PAGE_SIZE) break;
        cursor = page.docs[page.docs.length - 1];
      }
    }
  };

  for (const rootName of rootNames) {
    const snapshots = documentsByCollection.has(rootName)
      ? documentsByCollection.get(rootName)
      : await readCollectionDocuments(db.collection(rootName).select(...MEDIA_FIELD_PROJECTION));
    scannedCollections.push(rootName);
    for (const snapshot of snapshots) {
      await visitDocument(snapshot, rootName);
    }
  }

  return {
    references,
    profileDocuments,
    scannedDocumentCount,
    referenceDocumentCount: new Set(references.map((reference) => reference.path)).size,
    scannedCollections: scannedCollections.sort(),
  };
}

async function readUserProfilePhotoReferences(db, rootNames) {
  if (!rootNames.includes('users')) return [];
  // Project media-only fields; never read emails, phones, roles, credentials, or other profile data here.
  return readCollectionDocuments(db.collection('users').select(...MEDIA_FIELD_PROJECTION));
}

function isTestLikeText(data) {
  const fields = ['title', 'name', 'description', 'message', 'body', 'label', 'reason'];
  const text = fields.map((field) => data && data[field]).filter((value) => typeof value === 'string').join(' ');
  return /\b(test(?:ing)?|demo|sample|capstone|simulation)\b/i.test(text);
}

function isTestLikeRecord(document, data) {
  return isTestLikeText(data) || /(^|[_-])(test|demo|sample|capstone|simulation)([_-]|$)/i.test(document.id);
}

function toIsoDate(value) {
  if (value && typeof value.toDate === 'function') value = value.toDate();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function safeEnum(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9 _-]{1,60}$/.test(normalized) ? normalized.replace(/\s+/g, ' ') : 'other';
}

function safeReviewSnippet(value, maxLength = 220) {
  if (typeof value !== 'string') return null;
  let snippet = value.replace(/\s+/g, ' ').trim();
  if (!snippet) return null;
  snippet = snippet
    .replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/\b(?:\+?63|0)9\d{2}[-\s.]?\d{3}[-\s.]?\d{4}\b/g, '[phone omitted]')
    .replace(/\b-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}\b/g, '[coordinates omitted]')
    .replace(/\b(password|token|secret|uid|user\s*id|phone|mobile|email|address|contact)\s*[:=#-]\s*[^,;.!]+/gi, '$1: [redacted]')
    .replace(/\b(?:reported by|contact person|resident name|applicant name)\s*[:=-]?\s*[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){0,2}/gu, '[person omitted]');
  return snippet.length > maxLength ? snippet.slice(0, maxLength).trimEnd() + '…' : snippet;
}

function reviewDescriptionSummary(collection, data) {
  const type = safeReviewSnippet(String(data.type ?? data.kind ?? data.alertType ?? data.reportType ?? collection), 50);
  const status = safeReviewSnippet(String(data.status ?? data.state ?? data.verification ?? 'status unavailable'), 50);
  if (collection === 'alerts') {
    const title = safeReviewSnippet(data.title, 120) || 'untitled alert';
    const message = safeReviewSnippet(data.message ?? data.description, 220) || 'no message text';
    const category = safeReviewSnippet(data.category ?? data.alertType ?? data.type, 50);
    const priority = safeReviewSnippet(data.priority ?? data.severityLevel, 40);
    const coverage = data.locationScope && typeof data.locationScope.type === 'string'
      ? safeReviewSnippet(data.locationScope.type, 30)
      : safeReviewSnippet(data.coverageArea, 30);
    return `Public alert${category ? ' (' + category + ')' : ''}: ${title}. Message: ${message}.${priority ? ' Priority: ' + priority + '.' : ''}${coverage ? ' Coverage: ' + coverage + '.' : ''}`;
  }
  if (collection === 'reports') {
    const conditions = ['waterLevel', 'roadStatus', 'floodingLevel', 'cause']
      .filter((field) => typeof data[field] === 'string' && data[field].trim())
      .map((field) => field + ': ' + safeReviewSnippet(data[field], 80));
    return `${type} report; status: ${status}.${conditions.length ? ' Conditions: ' + conditions.join('; ') + '.' : ''} Narrative and exact location withheld from this review summary because they may contain personal details.`;
  }
  if (collection === 'notificationDeliveries') {
    const content = [data.title, data.body].filter((value) => typeof value === 'string').join(' ').toLowerCase();
    let contentClass = 'alert/report notification; message text and precise location omitted';
    if (/system test|test only|no emergency|sample|example/.test(content)) {
      contentClass = 'message explicitly labeled test/sample or no emergency; message text and recipient identifiers omitted';
    } else if (/road closure|road closed|traffic restriction/.test(content)) {
      contentClass = 'road closure/restriction advisory; message text and precise location omitted';
    } else if (/flood|water level|flooding/.test(content)) {
      contentClass = 'flood advisory/report update; message text and precise location omitted';
    }
    return `Notification delivery (${type}); state: ${status}; ${contentClass}.`;
  }
  if (collection === 'accessRequests') {
    const role = safeReviewSnippet(data.role, 60);
    const position = safeReviewSnippet(data.position, 80);
    const barangay = safeReviewSnippet(data.barangay, 80);
    return `Access request; status: ${status}.${role ? ' Requested role: ' + role + '.' : ''}${position ? ' Position: ' + position + '.' : ''}${barangay ? ' Barangay: ' + barangay + '.' : ''} Applicant identity, contact fields, and free-text reason withheld from this summary.`;
  }
  if (collection === 'householdRequests') {
    const requestType = safeReviewSnippet(data.requestType ?? data.action ?? data.type, 60);
    return `Household-related request; status: ${status}.${requestType ? ' Request type: ' + requestType + '.' : ''} Applicant details and free-text reason withheld from this summary.`;
  }
  if (collection === 'activeEvacuations') {
    return `Active evacuation activity record; current participation/occupancy reference. Household and center links are summarized separately.`;
  }
  if (collection === 'evacuationRecords') {
    return `Evacuation activity record; status: ${status}. Check-in/out history may be used for shelter accountability.`;
  }
  return `${collection} record; status: ${status}.`;
}

function reviewRelationships(collection, document, data, linkedTarget, linkedNotificationDeliveryCount) {
  const relationships = [];
  if (linkedTarget) relationships.push('source record: ' + linkedTarget.path);
  if (linkedNotificationDeliveryCount > 0) {
    relationships.push(linkedNotificationDeliveryCount + ' notification delivery record(s) reference this record');
  }
  if (data.householdId) {
    relationships.push('household association present (identifier withheld)');
  } else if (collection === 'activeEvacuations' && /^H-/.test(document.id)) {
    relationships.push('document key is a household record identifier');
  }
  if (data.centerId || data.evacuationCenterId || data.evacuationCenterRef) {
    relationships.push('evacuation center association present (identifier withheld)');
  }
  if (data.barangayId || data.barangay) relationships.push('barangay association present (identifier withheld)');
  if (data.userId || data.uid || data.reporterId || data.createdBy || data.createdByUid) {
    relationships.push('user/account association present (identifier withheld)');
  }
  if (data.locationScope && Array.isArray(data.locationScope.barangayIds)) {
    relationships.push(data.locationScope.type === 'municipality'
      ? 'municipality-wide alert scope'
      : 'alert scope includes ' + data.locationScope.barangayIds.length + ' barangay reference(s)');
  }
  if (collection === 'notificationDeliveries' && !linkedTarget && (data.targetId || data.sourcePath)) {
    relationships.push('alert/report target is unresolved in the current inventory (identifier withheld)');
  }
  return Array.from(new Set(relationships));
}

function deletionConsequence(collection) {
  const consequences = {
    reports: 'Would remove report history and its verification/status entry from management, map, and analytics views; referenced media may become orphaned.',
    alerts: 'Would remove an emergency advisory from alert history and current lists; already delivered push notifications cannot be recalled.',
    notificationDeliveries: 'Would remove delivery, retry, receipt, and deduplication history; it cannot retract a push already accepted by a provider.',
    evacuationRecords: 'Would remove evacuation check-in/out history used for shelter accountability.',
    activeEvacuations: 'Could change current occupancy or household-presence tracking and make operational totals inaccurate.',
    accessRequests: 'Would remove the access-request decision trail; it does not itself delete an Auth account or user profile.',
    householdRequests: 'Would remove the household-request decision trail; it may not reverse a membership change already applied.',
    evacuationCenters: 'Essential evacuation-center configuration is protected and is not eligible for deletion.',
  };
  return consequences[collection] || 'Would remove this record and any history stored only in it.';
}

function hasExplicitTestWording(data) {
  const fields = ['title', 'description', 'message', 'body', 'reason', 'label'];
  const text = fields.map((field) => data && data[field]).filter((value) => typeof value === 'string').join(' ');
  return /\b(?:test\s*only|system\s*test|no\s+emergency|sample(?:\s+alert|\s+message)?|demo(?:\s+only)?|example\s+notification)\b/i.test(text);
}

function reviewEvidenceAssessment(collection, document, data, classification) {
  if (classification.classification === 'essential-reference') return 'Essential reference/configuration; protected from deletion.';
  if (classification.classification === 'confirmed-test') return 'Explicit test marker is present; this is a deletion candidate.';
  if (hasExplicitTestWording(data)) return 'Content contains test/sample wording, but there is no explicit test marker; this alone does not confirm disposability.';
  if (isTestLikeRecord(document, data)) return 'Only the identifier/name/text signal looks test-like; that is insufficient to confirm disposability.';
  const status = String(data.status ?? data.state ?? data.verification ?? '').toLowerCase();
  if (collection === 'alerts' && ['active', 'published', 'monitoring'].includes(status)) return 'Active/published emergency advisory with no explicit test marker; treat as potentially real.';
  if (collection === 'reports' && ['verified', 'resolved'].includes(status)) return 'Verified/resolved operational report with no explicit test marker; treat as potentially real.';
  if (['activeEvacuations', 'evacuationRecords'].includes(collection)) return 'Evacuation activity can be safety-critical; no explicit test marker is present.';
  if (['accessRequests', 'householdRequests'].includes(collection)) return 'Approved request may support an existing account or household decision; no explicit test marker is present.';
  if (collection === 'notificationDeliveries') return 'Delivery/audit record has no confirmed test source; preserve its delivery and deduplication evidence.';
  return 'No reliable evidence confirms this record is disposable test data.';
}

function recommendedReviewAction(collection, document, data, classification) {
  if (classification.classification === 'confirmed-test') return 'Delete Candidate';
  if (classification.classification === 'essential-reference') return 'Preserve';
  if (hasExplicitTestWording(data)) return 'Requires Manual Review';
  if (isTestLikeRecord(document, data)) return 'Requires Manual Review';
  if (['reports', 'alerts', 'accessRequests', 'householdRequests', 'notificationDeliveries'].includes(collection)) return 'Preserve';
  return 'Requires Manual Review';
}

function notificationTarget(data, targets) {
  const sourcePath = typeof data.sourcePath === 'string' ? data.sourcePath : '';
  if (sourcePath && targets.byPath.has(sourcePath)) return targets.byPath.get(sourcePath);
  const matches = targets.byId.get(String(data.targetId)) || [];
  if (matches.length === 1) return matches[0];
  if (data.kind === 'report') return matches.find((target) => target.collection === 'reports') || null;
  if (data.kind === 'alert') return matches.find((target) => target.collection === 'alerts') || null;
  return null;
}

function classifyReviewRecord(collection, document, markers, linkedTarget, data) {
  if (isProtectedPath(document.ref.path)) {
    return { classification: 'essential-reference', proposedAction: 'preserve', reason: 'protected operational configuration; never eligible for cleanup deletion' };
  }
  if (markers.length) {
    return { classification: 'confirmed-test', proposedAction: 'delete', reason: 'explicit test marker: ' + markers.join(', ') };
  }
  if (linkedTarget && linkedTarget.marked) {
    return { classification: 'confirmed-test', proposedAction: 'delete', reason: 'notification linked to explicitly marked ' + linkedTarget.collection + ' record' };
  }
  if (collection === 'evacuationCenters' && !isTestLikeRecord(document, data)) {
    return { classification: 'essential-reference', proposedAction: 'preserve', reason: 'unmarked evacuation-center configuration; preserve unless confirmed test-only' };
  }
  if (isTestLikeRecord(document, data)) {
    return { classification: 'uncertain', proposedAction: 'preserve pending review', reason: 'test-like wording or identifier without an explicit test marker' };
  }
  if (linkedTarget) {
    return { classification: 'uncertain', proposedAction: 'preserve pending review', reason: 'linked to an unmarked ' + linkedTarget.collection + ' record' };
  }
  if (collection === 'notificationDeliveries') {
    const expiresAt = toIsoDate(data.expiresAt);
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      return { classification: 'uncertain', proposedAction: 'preserve pending review', reason: 'expired delivery record without a confirmed test source' };
    }
  }
  return { classification: 'uncertain', proposedAction: 'preserve pending review', reason: 'no explicit evidence that the record is disposable test data' };
}

function reviewMetadata(collection, document, data, classification, linkedTarget, linkedNotificationDeliveryCount = 0) {
  const typeValue = collection === 'alerts'
    ? data.category ?? data.alertType ?? data.type
    : data.type ?? data.kind ?? data.alertType ?? data.reportType;
  const statusValue = data.status ?? data.state ?? data.verification;
  const displayId = typeof data.displayId === 'string' && /^[A-Z]{2,4}\d{4,}$/.test(data.displayId) ? data.displayId : null;
  const createdAt = toIsoDate(data.createdAt ?? data.submittedAt ?? data.publishedAt);
  const updatedAt = toIsoDate(data.updatedAt ?? data.lastUpdatedAt ?? data.modifiedAt);
  const publishedAt = toIsoDate(data.publishedAt);
  const expiresAt = toIsoDate(data.expiresAt);
  const status = String(data.status ?? data.state ?? data.verification ?? '').toLowerCase();
  const workerRecoveryWindowMs = 60 * 60 * 1000;
  const alertReferenceTime = publishedAt || createdAt;
  const alertIsPublishedAndUnexpired = ['active', 'published', 'monitoring'].includes(status)
    && (!expiresAt || Date.parse(expiresAt) > Date.now());
  const workerRecoveryWindowOpen = alertReferenceTime !== null
    && Date.now() - Date.parse(alertReferenceTime) <= workerRecoveryWindowMs;
  return {
    path: document.ref.path,
    collection,
    classification: classification.classification,
    proposedAction: classification.proposedAction,
    reason: classification.reason,
    ...(displayId ? { displayId } : {}),
    ...(safeEnum(typeValue) ? { type: safeEnum(typeValue) } : {}),
    ...(safeEnum(statusValue) ? { status: safeEnum(statusValue) } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    testLikeSignal: isTestLikeRecord(document, data),
    evidenceAssessment: reviewEvidenceAssessment(collection, document, data, classification),
    recommendedAction: recommendedReviewAction(collection, document, data, classification),
    descriptionSummary: reviewDescriptionSummary(collection, data),
    relationships: reviewRelationships(collection, document, data, linkedTarget, linkedNotificationDeliveryCount),
    potentialDeletionConsequence: deletionConsequence(collection),
    ...(collection === 'alerts' ? {
      automatic: data.automatic === true,
      manualAlertRecoveryWindowOpenAtReview: data.automatic !== true
        && alertIsPublishedAndUnexpired
        && workerRecoveryWindowOpen,
      workerMayInspectAlertOnStartupAtReview: alertIsPublishedAndUnexpired
        && (data.automatic === true || workerRecoveryWindowOpen),
    } : {}),
    ...(collection === 'notificationDeliveries' ? {
      ...(Number.isFinite(data.attempts) ? { attempts: data.attempts } : {}),
      providerTicketPresent: Boolean(data.ticketId),
      revisionReferencePresent: Boolean(data.revision),
      hashedDeliveryDocumentId: /^[a-f0-9]{64}$/i.test(document.id),
    } : {}),
    attachmentReferenceCount: countAttachmentReferences(data),
    ...(linkedTarget ? { linkedRecordPath: linkedTarget.path } : {}),
  };
}

function summarizeNotifications(documents, targets, now) {
  const states = {};
  const references = { linkedToCurrentRecords: 0, unresolvedRecordReferences: 0, noRecordReference: 0 };
  const deduplicationReferences = {
    hashedDeliveryDocumentIds: 0,
    revisionReferences: 0,
    idempotencyReferences: 0,
    providerTickets: 0,
    deviceReferences: 0,
  };
  let expired = 0;
  let sendEligibleNow = 0;
  let receiptChecksDue = 0;
  let retrySendDue = 0;
  for (const document of documents) {
    const data = document.data() || {};
    const state = safeEnum(data.state ?? data.status) || 'unknown';
    states[state] = (states[state] || 0) + 1;
    if (/^[a-f0-9]{64}$/i.test(document.id)) deduplicationReferences.hashedDeliveryDocumentIds += 1;
    if (data.revision) deduplicationReferences.revisionReferences += 1;
    if (data.idempotencyKey || data.dedupeKey || data.eventKey) deduplicationReferences.idempotencyReferences += 1;
    if (data.ticketId) deduplicationReferences.providerTickets += 1;
    if (data.devicePath) deduplicationReferences.deviceReferences += 1;
    const expiry = toIsoDate(data.expiresAt);
    const nextAttempt = toIsoDate(data.nextAttemptAt);
    const expiredNow = expiry !== null && Date.parse(expiry) <= now.getTime();
    const dueNow = nextAttempt !== null && Date.parse(nextAttempt) <= now.getTime();
    if (expiredNow) expired += 1;
    if (notificationTarget(data, targets)) references.linkedToCurrentRecords += 1;
    else if (data.sourcePath || data.targetId) references.unresolvedRecordReferences += 1;
    else references.noRecordReference += 1;
    if (expiredNow) continue;
    if (state === 'pending' && (!nextAttempt || dueNow)) sendEligibleNow += 1;
    if (dueNow && data.ticketId) receiptChecksDue += 1;
    else if (dueNow && !data.ticketId) retrySendDue += 1;
  }
  return {
    documentCount: documents.length,
    states,
    expired,
    sendEligibleNow,
    retrySendDue,
    receiptChecksDue,
    references,
    deduplicationReferences,
  };
}

async function collectSubtree(snapshot, inheritedReason, rows, collectionCounts, attachmentCount) {
  const documentPath = snapshot.ref.path;
  if (!isAllowedCandidatePath(documentPath)) throw new Error('Protected document path encountered during inventory.');
  const data = snapshot.data() || {};
  rows.push({
    path: documentPath,
    collectionPath: snapshot.ref.parent.path,
    reason: inheritedReason,
    data,
  });
  collectionCounts[snapshot.ref.parent.path] = (collectionCounts[snapshot.ref.parent.path] || 0) + 1;
  attachmentCount.count += countAttachmentReferences(data);

  const childCollections = await snapshot.ref.listCollections();
  for (const childCollection of childCollections) {
    let cursor;
    while (true) {
      let query = childCollection.orderBy('__name__').limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const childDocument of page.docs) {
        await collectSubtree(childDocument, inheritedReason, rows, collectionCounts, attachmentCount);
      }
      if (page.size < PAGE_SIZE) break;
      cursor = page.docs[page.docs.length - 1];
    }
  }
}

function extractAttachmentReferences(value) {
  const references = [];
  const attachmentContext = /(attachments?|photos?|images?|media|evidence)/i;
  const urlField = /^(url|uri|src|downloadurl|download_url|secure_url|secureurl)$/i;
  const visit = (current, key = '', inAttachmentContext = false) => {
    if (typeof current === 'string') {
      if ((ATTACHMENT_FIELD.test(key) || (inAttachmentContext && urlField.test(key))) && current.trim()) references.push(current.trim());
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key, inAttachmentContext || attachmentContext.test(key));
      return;
    }
    if (!current || typeof current !== 'object' || current instanceof Date || typeof current.toDate === 'function') return;
    for (const [childKey, child] of Object.entries(current)) {
      visit(child, childKey, inAttachmentContext || attachmentContext.test(childKey) || ATTACHMENT_FIELD.test(childKey));
    }
  };
  visit(value);
  return references;
}

function normalizedAttachmentReference(value) {
  if (/^data:/i.test(value)) {
    return { identity: 'embedded:' + crypto.createHash('sha256').update(value).digest('hex'), provider: 'embedded' };
  }
  if (/^gs:\/\/\//i.test(value)) {
    return { identity: value.split('?')[0], provider: 'firebase-storage' };
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    const provider = /(^|\.)cloudinary\.com$/.test(host)
      ? 'cloudinary'
      : /firebasestorage\.googleapis\.com$|^storage\.googleapis\.com$/.test(host)
        ? 'firebase-storage'
        : 'other';
    return { identity: host + parsed.pathname, provider };
  } catch {
    return { identity: 'unparsed:' + crypto.createHash('sha256').update(value).digest('hex'), provider: 'unparsed' };
  }
}

function countAttachmentReferences(value) {
  return extractAttachmentReferences(value).length;
}

function summarizeAttachments(documentsByCollection, candidates, userProfileDocuments = [], options = {}) {
  const proposedObjects = new Map();
  const preservedObjects = new Map();
  const preservedProfileObjects = new Map();
  const proposedPathsByObject = new Map();
  const preservedPathsByObject = new Map();
  const proposedReferenceCountsByObject = new Map();
  const profileReferencesByObject = new Map();
  const providers = {};
  let profilePhotoReferenceCount = 0;
  let profileMediaReferenceCount = 0;
  let proposedReferenceCount = 0;
  const addPath = (map, identity, documentPath) => {
    const paths = map.get(identity) || new Set();
    paths.add(documentPath);
    map.set(identity, paths);
  };
  const addProposedReference = (rawReference, documentPath) => {
    const normalized = normalizedAttachmentReference(rawReference);
    proposedReferenceCount += 1;
    providers[normalized.provider] = (providers[normalized.provider] || 0) + 1;
    proposedObjects.set(normalized.identity, normalized.provider);
    addPath(proposedPathsByObject, normalized.identity, documentPath);
    proposedReferenceCountsByObject.set(normalized.identity, (proposedReferenceCountsByObject.get(normalized.identity) || 0) + 1);
  };
  const proposedDocuments = options.proposedDocuments;
  if (Array.isArray(proposedDocuments)) {
    for (const document of proposedDocuments) {
      for (const rawReference of extractAttachmentReferences(document.data || {})) {
        addProposedReference(rawReference, document.path);
      }
    }
  } else {
    for (const documents of documentsByCollection.values()) {
      for (const document of documents) {
        const proposed = candidates.has(document.ref.path);
        for (const rawReference of extractAttachmentReferences(document.data() || {})) {
          if (proposed) addProposedReference(rawReference, document.ref.path);
          else {
            const normalized = normalizedAttachmentReference(rawReference);
            preservedObjects.set(normalized.identity, normalized.provider);
            addPath(preservedPathsByObject, normalized.identity, document.ref.path);
          }
        }
      }
    }
  }
  if (Array.isArray(options.retainedMediaReferences)) {
    for (const reference of options.retainedMediaReferences) {
      const normalized = normalizedAttachmentReference(reference.rawReference);
      if (reference.rootCollection === 'users') {
        preservedProfileObjects.set(normalized.identity, normalized.provider);
        profileReferencesByObject.set(normalized.identity, (profileReferencesByObject.get(normalized.identity) || 0) + 1);
        profileMediaReferenceCount += 1;
      } else {
        preservedObjects.set(normalized.identity, normalized.provider);
        addPath(preservedPathsByObject, normalized.identity, reference.safePath || reference.path);
      }
    }
    for (const document of userProfileDocuments) {
      const data = document.data() || {};
      for (const rawReference of [data.photoURL, data.photoUrl]) {
        if (typeof rawReference === 'string' && rawReference.trim()) profilePhotoReferenceCount += 1;
      }
    }
  } else {
    for (const document of userProfileDocuments) {
      const data = document.data() || {};
      for (const rawReference of extractAttachmentReferences(data)) {
        const normalized = normalizedAttachmentReference(rawReference);
        preservedProfileObjects.set(normalized.identity, normalized.provider);
        profileReferencesByObject.set(normalized.identity, (profileReferencesByObject.get(normalized.identity) || 0) + 1);
        profileMediaReferenceCount += 1;
      }
      for (const rawReference of [data.photoURL, data.photoUrl]) {
        if (typeof rawReference !== 'string' || !rawReference.trim()) continue;
        const normalized = normalizedAttachmentReference(rawReference.trim());
        preservedProfileObjects.set(normalized.identity, normalized.provider);
        profilePhotoReferenceCount += 1;
      }
    }
  }
  const shared = Array.from(proposedObjects.keys()).filter((identity) => preservedObjects.has(identity));
  const sharedWithProfiles = Array.from(proposedObjects.keys()).filter((identity) => preservedProfileObjects.has(identity));
  const retainedObjects = new Set([...preservedObjects.keys(), ...preservedProfileObjects.keys()]);
  const retainedShared = Array.from(proposedObjects.keys()).filter((identity) => retainedObjects.has(identity));
  const objectUsage = Array.from(proposedObjects.entries()).map(([identity, provider]) => ({
    fingerprint: crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16),
    provider,
    proposedReferenceCount: proposedReferenceCountsByObject.get(identity) || 0,
    proposedRecordPaths: Array.from(proposedPathsByObject.get(identity) || []).sort(),
    retainedOperationalRecordPaths: Array.from(preservedPathsByObject.get(identity) || []).sort(),
    preservedProfilePictureReferenceCount: profileReferencesByObject.get(identity) || 0,
  })).sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  return {
    proposedReferenceCount,
    uniqueProposedObjects: proposedObjects.size,
    referencedByRetainedOperationalRecords: shared.length,
    referencedByPreservedProfilePictures: sharedWithProfiles.length,
    preservedProfilePhotoReferenceCount: profilePhotoReferenceCount,
    preservedProfileMediaReferenceCount: profileMediaReferenceCount,
    likelyOrphanedIfDeleted: Math.max(0, proposedObjects.size - retainedShared.length),
    providers,
    objectUsage,
    ...(options.mediaReferenceScan ? { mediaReferenceScan: options.mediaReferenceScan } : {
      mediaReferenceScan: { status: 'not-run; retained operational records outside candidate collections were not checked' },
    }),
    note: 'Object fingerprints are one-way hashes of normalized provider paths; raw URLs are omitted.',
  };
}

async function createInventory(db, projectId, now = new Date(), options = {}) {
  assertProject(projectId);
  const rootRefs = await db.listCollections();
  const rootNames = rootRefs.map((reference) => reference.id).sort();
  const rootInventory = [];
  for (const name of rootNames) {
    const reference = db.collection(name);
    const documentCount = await countDocuments(reference);
    rootInventory.push({
      name,
      documentCount,
      disposition: ESSENTIAL_REFERENCE_COLLECTIONS.includes(name)
        ? 'essential reference or configuration; preserved'
        : CANDIDATE_COLLECTIONS.includes(name)
          ? 'candidate scope; explicit test marker required'
          : 'outside cleanup scope; preserved',
      explicitMarkerCandidates: 0,
    });
  }

  const candidates = new Map();
  const markerCounts = {};
  const documentsByCollection = new Map();
  const markersByPath = new Map();
  const targets = { byPath: new Map(), byId: new Map() };
  let userProfilePhotoDocuments = [];
  for (const collectionName of CANDIDATE_COLLECTIONS) {
    const reference = db.collection(collectionName);
    if (!rootNames.includes(collectionName)) {
      markerCounts[collectionName] = { exists: false, documentCount: 0, markedCount: 0, reviewCount: 0 };
      continue;
    }
    const documents = await readCollectionDocuments(reference);
    documentsByCollection.set(collectionName, documents);
    let markedCount = 0;
    for (const document of documents) {
      const data = document.data() || {};
      const markers = isProtectedPath(document.ref.path) ? [] : explicitTestMarkerReasons(data);
      markersByPath.set(document.ref.path, markers);
      if (['reports', 'alerts'].includes(collectionName)) {
        const target = {
          id: document.id,
          path: document.ref.path,
          collection: collectionName,
          marked: markers.length > 0,
        };
        targets.byPath.set(target.path, target);
        const sameId = targets.byId.get(target.id) || [];
        sameId.push(target);
        targets.byId.set(target.id, sameId);
      }
      if (!markers.length) continue;
      markedCount += 1;
      candidates.set(document.ref.path, {
        snapshot: document,
        collection: collectionName,
        id: document.id,
        reason: 'explicit test marker: ' + markers.join(', '),
      });
    }
    markerCounts[collectionName] = {
      exists: true,
      documentCount: rootInventory.find((entry) => entry.name === collectionName).documentCount,
      scannedDocumentCount: documents.length,
      markedCount,
      reviewCount: Math.max(0, documents.length - markedCount),
    };
    const rootRecord = rootInventory.find((entry) => entry.name === collectionName);
    if (rootRecord) rootRecord.explicitMarkerCandidates = markedCount;
  }

  const notificationRelations = new Map();
  for (const document of documentsByCollection.get('notificationDeliveries') || []) {
    const data = document.data() || {};
    const target = notificationTarget(data, targets);
    notificationRelations.set(document.ref.path, target);
    const markers = markersByPath.get(document.ref.path) || [];
    if (!markers.length && !(target && target.marked)) continue;
    if (!candidates.has(document.ref.path)) {
      candidates.set(document.ref.path, {
        snapshot: document,
        collection: 'notificationDeliveries',
        id: document.id,
        reason: markers.length
          ? 'explicit test marker: ' + markers.join(', ')
          : 'linked to explicitly marked ' + target.collection + ' record ' + target.id,
      });
    }
  }

  const deliveryCountsByTargetPath = new Map();
  for (const target of notificationRelations.values()) {
    if (!target) continue;
    deliveryCountsByTargetPath.set(target.path, (deliveryCountsByTargetPath.get(target.path) || 0) + 1);
  }

  const reviewRecords = [];
  const reviewClassificationCounts = {};
  for (const [collectionName, documents] of documentsByCollection) {
    for (const document of documents) {
      const data = document.data() || {};
      const markers = markersByPath.get(document.ref.path) || [];
      const linkedTarget = collectionName === 'notificationDeliveries'
        ? notificationRelations.get(document.ref.path)
        : null;
      const classification = classifyReviewRecord(collectionName, document, markers, linkedTarget, data);
      const review = reviewMetadata(
        collectionName,
        document,
        data,
        classification,
        linkedTarget,
        deliveryCountsByTargetPath.get(document.ref.path) || 0,
      );
      reviewRecords.push(review);
      const key = collectionName + ':' + classification.classification;
      reviewClassificationCounts[key] = (reviewClassificationCounts[key] || 0) + 1;
    }
  }

  reviewRecords.sort((left, right) => left.path.localeCompare(right.path));
  const rows = [];
  const collectionCounts = {};
  const attachmentCount = { count: 0 };
  for (const candidate of candidates.values()) {
    await collectSubtree(candidate.snapshot, candidate.reason, rows, collectionCounts, attachmentCount);
  }

  const roots = Array.from(candidates.values()).map((candidate) => ({
    path: candidate.snapshot.ref.path,
    collection: candidate.collection,
    id: candidate.id,
    reason: candidate.reason,
    subtreeDocumentCount: rows.filter((row) => row.path === candidate.snapshot.ref.path
      || row.path.startsWith(candidate.snapshot.ref.path + '/')).length,
    ref: candidate.snapshot.ref,
  })).sort((left, right) => left.path.localeCompare(right.path));

  const reviewOnlyRows = [];
  const reviewOnlyCollectionCounts = {};
  const reviewOnlyAttachmentCount = { count: 0 };
  for (const [collectionName, documents] of documentsByCollection) {
    if (collectionName === 'evacuationCenters') continue;
    for (const document of documents) {
      if (candidates.has(document.ref.path)) continue;
      await collectSubtree(
        document,
        'encrypted review backup only; not a deletion candidate',
        reviewOnlyRows,
        reviewOnlyCollectionCounts,
        reviewOnlyAttachmentCount,
      );
    }
  }
  const reviewBackupDocuments = [...rows, ...reviewOnlyRows]
    .sort((left, right) => left.path.localeCompare(right.path));
  const reviewedDocumentFingerprints = reviewBackupDocuments.map((row) => ({
    path: row.path,
    scope: rows.includes(row) ? 'deletion-candidate' : 'review-only',
    sha256: crypto.createHash('sha256')
      .update(stableStringify(encodeFirestoreValue(row.data)))
      .digest('hex'),
  }));

  let mediaReferenceScan = null;
  let retainedMediaReferences;
  if (options.scanMediaReferences) {
    mediaReferenceScan = await scanRetainedMediaReferences(
      db,
      rootNames,
      documentsByCollection,
      roots.map((root) => root.path),
    );
    userProfilePhotoDocuments = mediaReferenceScan.profileDocuments;
    retainedMediaReferences = mediaReferenceScan.references;
  } else {
    userProfilePhotoDocuments = await readUserProfilePhotoReferences(db, rootNames);
    retainedMediaReferences = [];
    for (const documents of documentsByCollection.values()) {
      for (const document of documents) {
        if (candidates.has(document.ref.path)) continue;
        for (const rawReference of extractAttachmentReferences(document.data() || {})) {
          retainedMediaReferences.push({
            rawReference,
            path: document.ref.path,
            safePath: safeMediaReferencePath(document.ref.path),
            rootCollection: document.ref.path.split('/')[0],
          });
        }
      }
    }
    for (const document of userProfilePhotoDocuments) {
      for (const rawReference of extractAttachmentReferences(document.data() || {})) {
        retainedMediaReferences.push({
          rawReference,
          path: document.ref.path,
          safePath: safeMediaReferencePath(document.ref.path),
          rootCollection: 'users',
        });
      }
    }
  }
  const attachmentSummary = summarizeAttachments(
    documentsByCollection,
    candidates,
    userProfilePhotoDocuments,
    {
      proposedDocuments: rows,
      retainedMediaReferences,
      ...(mediaReferenceScan ? {
        mediaReferenceScan: {
          status: 'complete',
          scannedDocumentCount: mediaReferenceScan.scannedDocumentCount,
          referenceDocumentCount: mediaReferenceScan.referenceDocumentCount,
          scannedCollections: mediaReferenceScan.scannedCollections,
          rawUrlsIncluded: false,
          cloudinaryApiQueried: false,
        },
      } : {}),
    },
  );
  const notificationSummary = summarizeNotifications(documentsByCollection.get('notificationDeliveries') || [], targets, now);

  return {
    format: 'ligtas-cleanup-dry-run-v1',
    projectId,
    generatedAt: now.toISOString(),
    rootCollections: rootInventory,
    candidateCollectionCounts: markerCounts,
    protectedCollections: PROTECTED_COLLECTIONS.slice(),
    reviewRecords,
    reviewClassificationCounts,
    attachmentSummary,
    notificationSummary,
    candidateRoots: roots,
    candidateDocuments: rows,
    deletionCollectionCounts: collectionCounts,
    reviewOnlyCollectionCounts,
    reviewOnlyDocumentCount: reviewOnlyRows.length,
    reviewBackupDocuments,
    reviewedDocumentFingerprints,
    proposedDocumentCount: rows.length,
    explicitMarkerRootCount: roots.filter((root) => root.reason.startsWith('explicit test marker:')).length,
    linkedNotificationCount: roots.filter((root) => root.collection === 'notificationDeliveries'
      && !root.reason.startsWith('explicit test marker:')).length,
    attachmentReferenceCount: attachmentSummary.proposedReferenceCount,
    storageObjectsAction: mediaReferenceScan
      ? 'preserved; Firestore references were scanned using media-only projections; Cloudinary APIs were not queried and no objects were deleted'
      : 'preserved; external storage objects were not queried or deleted',
  };
}

function publicInventory(inventory) {
  const plan = {
    deletionCandidates: inventory.candidateDocuments
      .map((row) => ({
        path: row.path,
        reason: row.reason,
        documentSha256: crypto.createHash('sha256')
          .update(stableStringify(encodeFirestoreValue(row.data)))
          .digest('hex'),
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    reviewedRecords: inventory.reviewRecords,
    reviewedDocumentFingerprints: inventory.reviewedDocumentFingerprints,
    attachmentSummary: inventory.attachmentSummary,
    notificationSummary: inventory.notificationSummary,
  };
  const planSha256 = crypto.createHash('sha256').update(stableStringify(plan)).digest('hex');
  return {
    format: inventory.format,
    projectId: inventory.projectId,
    generatedAt: inventory.generatedAt,
    rootCollections: inventory.rootCollections,
    candidateCollectionCounts: inventory.candidateCollectionCounts,
    protectedCollections: inventory.protectedCollections,
    reviewRecords: inventory.reviewRecords,
    reviewClassificationCounts: inventory.reviewClassificationCounts,
    reviewOnlyCollectionCounts: inventory.reviewOnlyCollectionCounts,
    reviewOnlyDocumentCount: inventory.reviewOnlyDocumentCount,
    backupScope: {
      deletionCandidateDocuments: inventory.proposedDocumentCount,
      reviewOnlyDocuments: inventory.reviewOnlyDocumentCount,
      totalDocuments: inventory.reviewBackupDocuments.length,
      includesProtectedCollections: false,
    },
    proposedDocumentCount: inventory.proposedDocumentCount,
    planSha256,
    explicitMarkerRootCount: inventory.explicitMarkerRootCount,
    linkedNotificationCount: inventory.linkedNotificationCount,
    deletionCollectionCounts: inventory.deletionCollectionCounts,
    candidateRoots: inventory.candidateRoots.map(({ path: documentPath, collection, reason, subtreeDocumentCount }) => ({
      path: documentPath,
      collection,
      reason,
      subtreeDocumentCount,
    })),
    attachmentReferenceCount: inventory.attachmentReferenceCount,
    attachmentSummary: inventory.attachmentSummary,
    notificationSummary: inventory.notificationSummary,
    storageObjectsAction: inventory.storageObjectsAction,
    idCounters: 'preserved; no counter reset is proposed',
  };
}

function getAuditDirectory(configuredPath) {
  return path.resolve(configuredPath || path.join(path.dirname(path.dirname(__dirname)), '_private_cleanup_audit'));
}

async function writeAudit(directory, report) {
  await fs.promises.mkdir(directory, { recursive: true });
  const time = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, 'ligtas-cleanup-' + time + '.json');
  await fs.promises.writeFile(filePath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  return filePath;
}

function makeBackupArchive(inventory) {
  const candidatePaths = new Set((inventory.candidateDocuments || []).map((row) => row.path));
  const backupRows = inventory.reviewBackupDocuments || inventory.candidateDocuments;
  const documents = backupRows.map((row) => {
    assertNoSensitiveFields(row.data, row.path);
    const scope = candidatePaths.has(row.path) ? 'deletion-candidate' : 'review-only';
    return {
      path: row.path,
      collectionPath: row.collectionPath,
      scope,
      reason: row.reason,
      data: encodeFirestoreValue(row.data),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const deletionCandidateDocumentCount = documents.filter((row) => row.scope === 'deletion-candidate').length;
  return {
    format: FORMAT,
    projectId: inventory.projectId,
    createdAt: inventory.generatedAt,
    documentCount: documents.length,
    deletionCandidateDocumentCount,
    reviewOnlyDocumentCount: documents.length - deletionCandidateDocumentCount,
    documents,
  };
}

async function writeVerifiedBackup(inventory, backupPath, key) {
  const archive = makeBackupArchive(inventory);
  validateBackupArchive(archive, inventory.projectId);
  const encrypted = encryptBackup(archive, key);
  await fs.promises.mkdir(path.dirname(backupPath), { recursive: true });
  const temporaryPath = backupPath + '.tmp-' + crypto.randomUUID();
  try {
    await fs.promises.writeFile(temporaryPath, encrypted, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporaryPath, backupPath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  const verified = decryptBackup(await fs.promises.readFile(backupPath), key, inventory.projectId);
  const expectedDocumentCount = inventory.reviewBackupDocuments
    ? inventory.reviewBackupDocuments.length
    : inventory.proposedDocumentCount;
  if (verified.documentCount !== expectedDocumentCount) {
    throw new Error('Verified backup record count does not match the complete review backup scope.');
  }
  return {
    path: backupPath,
    documentCount: verified.documentCount,
    deletionCandidateDocumentCount: verified.deletionCandidateDocumentCount ?? inventory.proposedDocumentCount,
    reviewOnlyDocumentCount: verified.reviewOnlyDocumentCount ?? 0,
    integrity: 'AES-GCM authentication and SHA-256 verified',
    restoreReadiness: 'all records decrypted and schema-validated; Firestore restore not run',
  };
}

async function restoreBackup(db, backupPath, key, projectId) {
  const archive = decryptBackup(await fs.promises.readFile(backupPath), key, projectId);
  const { Timestamp, GeoPoint } = require('firebase-admin/firestore');
  const factories = { Timestamp, GeoPoint, db };
  const decoded = archive.documents.map((row) => ({
    path: row.path,
    data: decodeFirestoreValue(row.data, factories),
  })).sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path));

  const pending = [];
  for (const item of decoded) {
    const reference = db.doc(item.path);
    const snapshot = await reference.get();
    if (!snapshot.exists) {
      pending.push({ reference, data: item.data });
      continue;
    }
    const current = encodeFirestoreValue(snapshot.data());
    const expected = archive.documents.find((row) => row.path === item.path).data;
    if (stableStringify(current) !== stableStringify(expected)) {
      throw new Error('Restore stopped before writing because a document already exists with different data: ' + item.path);
    }
  }
  for (const item of pending) await item.reference.create(item.data);
  return { restored: pending.length, alreadyPresent: decoded.length - pending.length };
}

async function deleteCandidates(db, inventory) {
  if (typeof db.recursiveDelete !== 'function') {
    throw new Error('This Firebase Admin SDK does not expose recursiveDelete; no Firestore documents were deleted.');
  }
  const failures = [];
  let deletedRoots = 0;
  for (const root of inventory.candidateRoots) {
    try {
      await db.recursiveDelete(root.ref);
      deletedRoots += 1;
    } catch (error) {
      failures.push({ path: root.path, error: String(error && error.message || error).slice(0, 300) });
    }
  }
  return { deletedRoots, failures };
}

function defaultBackupPath(directory, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join(directory, 'ligtas-cleanup-backup-' + EXPECTED_PROJECT + '-' + stamp + '.enc.json');
}

function helpText() {
  return [
    'LigTAS test-data cleanup (dry-run is the default)',
    '',
    'Dry-run:  node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c',
    'Media:    node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c --scan-media-references',
    'Backup:   node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c --backup-only',
    'Secrets:  approved-secret-manager read <secret-ref> | node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c --backup-only --backup-key-stdin',
    'Delete:   node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c --execute --confirm-delete=DELETE-TEST-DATA:ligtas-d7a4c --approve-plan=<dry-run-hash>',
    'No backup: exact 15-path waiver only; requires --no-backup --confirm-no-backup=' + NO_BACKUP_CONFIRMATION,
    'Verify:   node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c --verify-backup <encrypted-file>',
    'Restore:  node scripts/cleanup-test-data.cjs --project=ligtas-d7a4c --restore --backup=<encrypted-file> --confirm-restore=RESTORE-TEST-DATA:ligtas-d7a4c',
    '',
    'Deletion only includes explicit test-marked records and notification entries linked to marked reports or alerts.',
    'User, configuration, audit, and ID-counter collections are protected. Unmarked records remain for review.',
    'External media objects are never deleted. --scan-media-references checks Firestore references with media-only projections. Firebase Authentication is never changed.',
  ].join('\n');
}

function loadFirebase(projectId) {
  require('dotenv').config({ path: path.join(path.dirname(__dirname), '.env'), override: false, quiet: true });
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== projectId) {
    throw new Error('The backend environment is configured for a different Firebase project. No database was changed.');
  }
  const { initializeApp, cert, applicationDefault, getApps } = require('firebase-admin/app');
  const credentialPathValue = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credentialPath = credentialPathValue
    ? (path.isAbsolute(credentialPathValue) ? credentialPathValue : path.resolve(path.dirname(__dirname), credentialPathValue))
    : path.join(path.dirname(__dirname), 'serviceAccountKey.json');
  let credential = applicationDefault();
  if (credentialPathValue && !fs.existsSync(credentialPath)) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS refers to a missing file. No database was changed.');
  }
  if (fs.existsSync(credentialPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    if (serviceAccount.project_id !== projectId) {
      throw new Error('The configured service account belongs to a different Firebase project. No database was changed.');
    }
    credential = cert(serviceAccount);
  }
  const app = getApps().length ? getApps()[0] : initializeApp({ credential, projectId });
  return require('firebase-admin/firestore').getFirestore(app);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(helpText() + '\n');
    return;
  }
  const key = !options.noBackup && (options.mode === 'execute' || options.mode === 'restore' || options.mode === 'backup-only' || options.verifyBackup)
    ? await getBackupKeyForOptions(options)
    : null;

  if (options.verifyBackup) {
    assertProject(options.projectId);
    const archive = decryptBackup(await fs.promises.readFile(path.resolve(options.verifyBackup)), key, options.projectId);
    process.stdout.write(JSON.stringify({
      projectId: options.projectId,
      documentCount: archive.documentCount,
      integrity: 'AES-GCM authentication and SHA-256 verified',
      restoreReadiness: 'all records decrypted and schema-validated; Firestore restore not run',
    }, null, 2) + '\n');
    return;
  }

  if (options.mode === 'restore') {
    assertProject(options.projectId);
    if (!options.backupPath || options.confirmRestore !== 'RESTORE-TEST-DATA:' + EXPECTED_PROJECT) {
      throw new Error('Restore requires --backup=<encrypted-file> and --confirm-restore=RESTORE-TEST-DATA:' + EXPECTED_PROJECT + '.');
    }
    const db = loadFirebase(options.projectId);
    const result = await restoreBackup(db, path.resolve(options.backupPath), key, options.projectId);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  assertProject(options.projectId);

  const db = loadFirebase(options.projectId);
  const inventory = await createInventory(db, options.projectId, new Date(), {
    scanMediaReferences: options.scanMediaReferences,
  });
  const auditDirectory = getAuditDirectory(options.auditDir);
  const auditReport = publicInventory(inventory);
  if (options.mode === 'execute') {
    assertDeleteApproval(options, auditReport.planSha256, Boolean(key), inventory.candidateRoots);
  }

  if (options.mode === 'dry-run') {
    auditReport.mode = 'dry-run';
    const auditPath = await writeAudit(auditDirectory, auditReport);
    process.stdout.write(JSON.stringify({ ...auditReport, auditPath }, null, 2) + '\n');
    return;
  }

  if (options.mode === 'backup-only') {
    const backupPath = path.resolve(options.backupPath || defaultBackupPath(auditDirectory));
    auditReport.mode = 'backup-only';
    auditReport.backup = await writeVerifiedBackup(inventory, backupPath, key);
    const auditPath = await writeAudit(auditDirectory, auditReport);
    process.stdout.write(JSON.stringify({ ...auditReport, auditPath }, null, 2) + '\n');
    return;
  }

  if (inventory.proposedDocumentCount === 0) {
    auditReport.mode = 'execute';
    auditReport.result = 'no explicitly marked disposable records found; nothing deleted';
    const auditPath = await writeAudit(auditDirectory, auditReport);
    process.stdout.write(JSON.stringify({ ...auditReport, auditPath }, null, 2) + '\n');
    return;
  }

  const backup = options.noBackup
    ? {
      status: 'explicitly waived by user for the exact 15 approved isDemo=true simulation records',
      encryptedBackupCreated: false,
    }
    : await writeVerifiedBackup(inventory, path.resolve(options.backupPath || defaultBackupPath(auditDirectory)), key);
  const result = await deleteCandidates(db, inventory);
  auditReport.mode = 'execute';
  auditReport.backup = backup;
  auditReport.deletion = result;
  auditReport.result = result.failures.length ? 'partial failure; inspect audit and rerun dry-run before retrying' : 'complete';
  const auditPath = await writeAudit(auditDirectory, auditReport);
  process.stdout.write(JSON.stringify({ ...auditReport, auditPath }, null, 2) + '\n');
  if (result.failures.length) process.exitCode = 2;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write('LigTAS cleanup stopped safely: ' + String(error && error.message || error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  CANDIDATE_COLLECTIONS,
  ESSENTIAL_REFERENCE_COLLECTIONS,
  EXPECTED_PROJECT,
  NO_BACKUP_APPROVED_ROOTS,
  NO_BACKUP_CONFIRMATION,
  PROTECTED_COLLECTIONS,
  assertDeleteApproval,
  assertExactNoBackupScope,
  assertNoSensitiveFields,
  countAttachmentReferences,
  createInventory,
  decodeBackup: decryptBackup,
  decodeFirestoreValue,
  decryptBackup,
  encodeFirestoreValue,
  encryptBackup,
  extractAttachmentReferences,
  getAuditDirectory,
  getBackupKey,
  getBackupKeyForOptions,
  loadFirebase,
  isAllowedCandidatePath,
  isProtectedPath,
  makeBackupArchive,
  parseArgs,
  publicInventory,
  restoreBackup,
  readBackupKeyFromStream,
  summarizeAttachments,
  validateBackupArchive,
  writeVerifiedBackup,
};
