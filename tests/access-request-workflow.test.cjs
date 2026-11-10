const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const express = require('express');

let role = 'SUPER_ADMIN';
let rows;
let authUsers;
let authEmails;
let audits;
let nextUserId;
let nextAuditId;
let nextDisplayId;
let transactionFailure;
let beforeNextTransaction;
let failAuditCreate;
let createUserFailure;
let mailFailure;
let mailCalls;
let transactionTail = Promise.resolve();

const snapshotFor = reference => {
  const row = rows.get(reference.path);
  return { id: reference.id, exists: Boolean(row), data: () => row && { ...row } };
};

const makeReference = path => ({ path, id: path.slice(path.lastIndexOf('/') + 1), async get() { return snapshotFor(this); } });
const queryRows = (name, filters, maximum) => [...rows.entries()]
  .filter(([path, value]) => path.startsWith(`${name}/`) && filters.every(([field, expected]) => value[field] === expected))
  .slice(0, maximum ?? Infinity)
  .map(([path, value]) => ({ id: path.slice(path.lastIndexOf('/') + 1), exists: true, data: () => ({ ...value }) }));
const makeQuery = (name, filters = [], maximum) => ({
  query: true,
  name,
  filters,
  maximum,
  where(field, operator, expected) {
    if (operator !== '==') throw new Error(`Unsupported fake query operator: ${operator}`);
    return makeQuery(name, [...filters, [field, expected]], maximum);
  },
  limit(value) { return makeQuery(name, filters, value); },
  orderBy() { return makeQuery(name, filters, maximum); },
  async get() {
    const docs = queryRows(name, filters, maximum);
    return { docs, empty: docs.length === 0, size: docs.length };
  },
});

const db = {
  doc: makeReference,
  collection(name) {
    return {
      doc(id) {
        const documentId = id || `audit-${++nextAuditId}`;
        return makeReference(`${name}/${documentId}`);
      },
      where(field, operator, value) { return makeQuery(name).where(field, operator, value); },
      orderBy(field, direction) { return makeQuery(name).orderBy(field, direction); },
      async get() { return makeQuery(name).get(); },
    };
  },
  runTransaction(callback) {
    const run = transactionTail.then(async () => {
      if (transactionFailure) throw transactionFailure;
      const beforeTransaction = beforeNextTransaction;
      beforeNextTransaction = null;
      if (beforeTransaction) await beforeTransaction();
      const writes = [];
      const transaction = {
        async get(reference) { return reference.query ? reference.get() : snapshotFor(reference); },
        create(reference, value) {
          if (failAuditCreate && reference.path.startsWith('auditLogs/')) throw new Error('simulated audit write failure');
          writes.push({ kind: 'create', reference, value });
        },
        update(reference, value) { writes.push({ kind: 'update', reference, value }); },
      };
      const result = await callback(transaction);
      for (const write of writes) {
        if (write.kind === 'create') {
          if (rows.has(write.reference.path)) throw new Error(`Document already exists: ${write.reference.path}`);
          rows.set(write.reference.path, { ...write.value });
        } else {
          const current = rows.get(write.reference.path);
          if (!current) throw new Error(`Document does not exist: ${write.reference.path}`);
          rows.set(write.reference.path, { ...current, ...write.value });
        }
      }
      return result;
    });
    transactionTail = run.catch(() => undefined);
    return run;
  },
};

const auth = {
  async createUser({ email, ...profile }) {
    if (createUserFailure) throw createUserFailure;
    if (authEmails.has(email)) throw Object.assign(new Error('email already exists'), { code: 'auth/email-already-exists' });
    const uid = `created-user-${++nextUserId}`;
    authEmails.set(email, uid);
    authUsers.set(uid, { uid, email, ...profile });
    return { uid, email };
  },
  async deleteUser(uid) {
    const user = authUsers.get(uid);
    if (user) authEmails.delete(user.email);
    authUsers.delete(uid);
  },
};

const actor = () => ({ uid: 'reviewer-uid', role, name: 'Review Admin', email: 'reviewer@example.test' });
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db, auth } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) { req.user = actor(); next(); },
    requireOfficial(_req, _res, next) { next(); },
  },
};
require.cache[require.resolve('../dist/services/auditLog')] = {
  exports: {
    async logAction(params) { audits.push({ ...params }); },
    logActionInTransaction(transaction, params) {
      const reference = db.collection('auditLogs').doc();
      transaction.create(reference, { ...params, timestamp: new Date() });
      return reference;
    },
  },
};
require.cache[require.resolve('../dist/services/firestoreReadCache')] = { exports: { invalidateFirestoreReadCache() {} } };
require.cache[require.resolve('../dist/services/firestoreErrors')] = {
  exports: { respondToFirestoreResourceExhausted() { return false; } },
};
require.cache[require.resolve('../dist/services/recordDisplayIds')] = {
  exports: { async allocateDisplayId(_transaction, _db, collection) { return `${collection === 'users' ? 'ACC-' : 'ACR'}${String(++nextDisplayId).padStart(collection === 'users' ? 5 : 4, '0')}`; } },
};
require.cache[require.resolve('../dist/services/accessRequestEmail')] = {
  exports: {
    async sendAccessRequestRejectionEmail(message) {
      mailCalls.push(message);
      if (mailFailure) throw mailFailure;
    },
  },
};
require.cache[require.resolve('../dist/services/profileFields')] = {
  exports: {
    isValidEmail(value) { return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); },
    firebaseAuthPhotoUrl(value) { return value || undefined; },
    isValidProfilePhoto() { return true; },
  },
};
require.cache[require.resolve('../dist/services/inputValidation')] = {
  exports: {
    validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; },
    validDocumentId(value) { return typeof value === 'string' && value.trim().length > 0 && !value.includes('/') && value !== '.' && value !== '..'; },
  },
};
require.cache[require.resolve('../dist/services/roles')] = {
  exports: {
    normalizeRole(value) { return String(value || '').toUpperCase().replace(/[ -]+/g, '_'); },
    SUPER_ADMIN_ROLE_VALUES: ['SUPER_ADMIN', 'SUPERADMIN'],
  },
};
require.cache[require.resolve('../dist/services/activityTracking')] = {
  exports: {
    async recordAuthenticatedActivity() {},
    async recordAuthenticatedLogin() {},
    shouldTrackAuthenticatedActivity() { return true; },
  },
};

const app = express();
app.use(express.json());
app.use('/users', require('../dist/routes/users').default);
app.use('/access-requests', require('../dist/routes/accessRequests').default);
let server;
let base;
const smtpKeys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE'];
const originalSmtp = Object.fromEntries(smtpKeys.map(key => [key, process.env[key]]));

before(async () => {
  smtpKeys.forEach(key => delete process.env[key]);
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  role = 'SUPER_ADMIN';
  rows = new Map();
  authUsers = new Map();
  authEmails = new Map();
  audits = [];
  nextUserId = 0;
  nextAuditId = 0;
  nextDisplayId = 0;
  transactionFailure = null;
  beforeNextTransaction = null;
  failAuditCreate = false;
  createUserFailure = null;
  mailFailure = null;
  mailCalls = [];
  transactionTail = Promise.resolve();
  smtpKeys.forEach(key => delete process.env[key]);
});

after(() => {
  server.closeAllConnections();
  server.close();
  for (const key of smtpKeys) {
    if (originalSmtp[key] === undefined) delete process.env[key];
    else process.env[key] = originalSmtp[key];
  }
});

function addPendingRequest(id = 'request-001', overrides = {}) {
  rows.set(`accessRequests/${id}`, {
    fullName: 'Applicant Example', email: 'applicant@example.test', role: 'LGU Admin', status: 'Pending',
    createdAt: new Date('2026-11-01T00:00:00.000Z'), ...overrides,
  });
  return id;
}

const validAccessRequest = () => ({
  fullName: 'New Applicant', email: 'new.applicant@example.test', phone: '09170000000',
  position: 'MDRRMO Personnel', barangay: 'Borol 1st', barangayId: 'barangay_borol_1st',
  role: 'Barangay Official', reason: 'Support municipal emergency coordination.',
});

async function submitAccessRequest(values = {}) {
  return fetch(`${base}/access-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...validAccessRequest(), ...values }),
  });
}

async function reject(id, body = { status: 'Rejected', rejectionReason: 'The submitted details could not be verified.' }) {
  return fetch(`${base}/access-requests/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function register(values = {}) {
  return fetch(`${base}/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Applicant Example', email: 'applicant@example.test', password: 'initial-password-123', role: 'LGU_ADMIN', accessRequestId: 'request-001', ...values,
    }),
  });
}

test('request registration creates Auth and profile and approves the linked request', async () => {
  addPendingRequest();
  const response = await register();
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.data.email, 'applicant@example.test');
  assert.equal(authUsers.size, 1);
  assert.equal(rows.get(`users/${payload.data.id}`).role, 'LGU_ADMIN');
  assert.equal(rows.get('accessRequests/request-001').status, 'Approved');
  assert.equal(rows.get('accessRequests/request-001').registeredUserId, payload.data.id);
  const approvalAudit = [...rows.entries()].find(([path]) => path.startsWith('auditLogs/'))?.[1];
  assert.equal(approvalAudit.action, 'user_created');
  assert.equal(approvalAudit.targetId, payload.data.id);
  assert.equal(approvalAudit.details.accessRequestId, 'request-001');
});

test('simultaneous duplicate registrations cannot create duplicate Auth accounts', async () => {
  addPendingRequest();
  const results = await Promise.all([register(), register()]);
  assert.deepEqual(results.map(response => response.status).sort(), [201, 409]);
  assert.equal(rows.get('accessRequests/request-001').status, 'Approved');
  assert.equal([...rows.keys()].filter(path => path.startsWith('users/')).length, 1);
  assert.equal(authUsers.size, 1);
  assert.equal([...rows.keys()].filter(path => path.startsWith('auditLogs/')).length, 1);
});

test('approval rechecks request status inside the transaction and cleans up the new Auth account on a race', async () => {
  addPendingRequest();
  beforeNextTransaction = async () => {
    const current = rows.get('accessRequests/request-001');
    rows.set('accessRequests/request-001', { ...current, status: 'Rejected' });
  };
  const response = await register();
  assert.equal(response.status, 409);
  assert.equal(rows.get('accessRequests/request-001').status, 'Rejected');
  assert.equal([...rows.keys()].some(path => path.startsWith('users/')), false);
  assert.equal(authUsers.size, 0);
});

test('duplicate email is reported without creating a Firestore profile or changing the request', async () => {
  addPendingRequest();
  authEmails.set('applicant@example.test', 'existing-auth-user');
  authUsers.set('existing-auth-user', { uid: 'existing-auth-user', email: 'applicant@example.test' });
  const response = await register();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'This email is already registered.');
  assert.equal(rows.has('users/existing-auth-user'), false);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
});

test('public access request options are loaded from configured role and barangay sources', async () => {
  rows.set('barangays/wawa', { name: 'Wawa' });
  rows.set('barangays/borol_1st', { name: 'Borol 1st' });
  const response = await fetch(`${base}/access-requests/options`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.roles.map(item => item.value), ['Barangay Official', 'LGU Staff']);
  assert.deepEqual(payload.data.barangays.map(item => item.id), ['borol_1st', 'wawa']);
});

test('valid access request submission stores the canonical barangay and a pending request', async () => {
  rows.set('barangays/barangay_borol_1st', { name: 'Borol 1st' });
  const response = await submitAccessRequest();
  const payload = await response.json();
  assert.equal(response.status, 201);
  assert.equal(payload.data.status, 'Pending');
  assert.equal(rows.get(`accessRequests/${payload.data.id}`).barangay, 'Borol 1st');
  assert.equal(rows.get(`accessRequests/${payload.data.id}`).barangayId, 'barangay_borol_1st');
});

test('invalid access request fields and unregistered barangays are rejected', async () => {
  assert.equal((await submitAccessRequest({ reason: '   ' })).status, 400);
  assert.equal((await submitAccessRequest({ role: 'Super Admin' })).status, 400);
  assert.equal((await submitAccessRequest({ barangayId: 'missing', barangay: 'Not a Barangay' })).status, 400);
  assert.equal([...rows.keys()].some(path => path.startsWith('accessRequests/')), false);
});

test('a repeated pending request for the same email is rejected atomically', async () => {
  rows.set('barangays/barangay_borol_1st', { name: 'Borol 1st' });
  const first = await submitAccessRequest();
  const second = await submitAccessRequest({ fullName: 'Different spelling', email: ' NEW.APPLICANT@example.test ' });
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal([...rows.keys()].filter(path => path.startsWith('accessRequests/')).length, 1);
});

test('registration cannot associate a different email with an access request', async () => {
  addPendingRequest();
  const response = await register({ email: 'another-person@example.test' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'The registered email must match the access request.');
  assert.equal(authUsers.size, 0);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
});

test('Firestore approval failure compensates by deleting the newly created Auth account', async () => {
  addPendingRequest();
  transactionFailure = new Error('simulated Firestore transaction failure');
  const response = await register();
  assert.equal(response.status, 500);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
  assert.equal([...rows.keys()].some(path => path.startsWith('users/')), false);
  assert.equal(authUsers.size, 0);
});

test('approval audit failure rolls back profile and request changes and compensates Auth creation', async () => {
  addPendingRequest();
  failAuditCreate = true;
  const response = await register();
  assert.equal(response.status, 500);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
  assert.equal([...rows.keys()].some(path => path.startsWith('users/')), false);
  assert.equal([...rows.keys()].some(path => path.startsWith('auditLogs/')), false);
  assert.equal(authUsers.size, 0);
});

test('rejection without SMTP saves the reason and reviewer and atomically records an audit with emailSent false', async () => {
  const id = addPendingRequest();
  const response = await reject(id);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.data.status, 'Rejected');
  assert.equal(payload.data.rejectionReason, 'The submitted details could not be verified.');
  assert.equal(payload.data.reviewedBy, 'reviewer-uid');
  assert.equal(typeof payload.data.reviewedAt, 'string');
  assert.deepEqual(payload.notification, { emailSent: false });
  assert.equal(rows.get('accessRequests/request-001').status, 'Rejected');
  const rejectionAudit = [...rows.entries()].find(([path]) => path.startsWith('auditLogs/'))?.[1];
  assert.equal(rejectionAudit.action, 'access_request_rejected');
  assert.equal(rejectionAudit.targetId, 'request-001');
  assert.equal(rejectionAudit.details.rejectionReason, 'The submitted details could not be verified.');
  assert.equal(mailCalls.length, 0);
});

test('barangay officials cannot decide municipality access requests', async () => {
  addPendingRequest();
  role = 'BARANGAY_OFFICIAL';
  const response = await reject('request-001');
  assert.equal(response.status, 403);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
  assert.equal([...rows.keys()].some(path => path.startsWith('auditLogs/')), false);
});

test('rejection requires a non-empty reason and does not change request or audit data when invalid', async () => {
  addPendingRequest();
  const response = await reject('request-001', { status: 'Rejected', rejectionReason: '  ' });
  assert.equal(response.status, 400);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
  assert.equal([...rows.keys()].some(path => path.startsWith('auditLogs/')), false);
});

test('duplicate and conflicting decisions return 409 without duplicate audit or email', async () => {
  addPendingRequest();
  assert.equal((await reject('request-001')).status, 200);
  const second = await reject('request-001');
  assert.equal(second.status, 409);
  assert.equal([...rows.keys()].filter(path => path.startsWith('auditLogs/')).length, 1);
  assert.equal(mailCalls.length, 0);
});

test('configured email delivery is reported accurately and a delivery failure does not undo rejection', async () => {
  for (const [key, value] of Object.entries({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'mailer', SMTP_PASS: 'test-only', SMTP_FROM: 'noreply@example.test' })) process.env[key] = value;
  addPendingRequest('mail-success');
  const sent = await reject('mail-success');
  assert.deepEqual((await sent.json()).notification, { emailSent: true });
  assert.equal(mailCalls.length, 1);

  addPendingRequest('mail-failure');
  mailFailure = Object.assign(new Error('SMTP unavailable'), { code: 'ECONNECTION' });
  const failed = await reject('mail-failure');
  const failedPayload = await failed.json();
  assert.equal(failed.status, 200);
  assert.deepEqual(failedPayload.notification, { emailSent: false });
  assert.equal(rows.get('accessRequests/mail-failure').status, 'Rejected');
});

test('audit transaction failure leaves the request pending and sends no email', async () => {
  addPendingRequest();
  failAuditCreate = true;
  const response = await reject('request-001');
  assert.equal(response.status, 500);
  assert.equal(rows.get('accessRequests/request-001').status, 'Pending');
  assert.equal([...rows.keys()].some(path => path.startsWith('auditLogs/')), false);
  assert.equal(mailCalls.length, 0);
});
