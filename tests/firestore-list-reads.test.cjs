const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

let role = 'LGU_ADMIN';
let reportFailure = false;
let auditFailure = false;
let reportId = 1;
let auditId = 1;
let reportDisplayId = 0;
let reads = { reports: 0, auditLogs: 0 };
const records = {
  reports: [{ id: 'report-1', data: { type: 'flood', status: 'Verified', barangayId: 'wawa' } }],
  auditLogs: [{ id: 'audit-1', data: { action: 'report_submitted', targetType:'report', timestamp: new Date('2026-11-08T00:00:00Z') } }],
};

const db = {
  collection(name) {
    let selected = records[name] ?? [];
    const query = {
      where(field, operator, value) {
        selected = selected.filter(item => operator === 'in' ? value.includes(item.data[field]) : item.data[field] === value);
        return this;
      },
      orderBy() { return this; },
      limit() { return this; },
      async get() {
        reads[name] = (reads[name] ?? 0) + 1;
        if (name === 'reports' && reportFailure) throw Object.assign(new Error('quota'), { code: 'RESOURCE_EXHAUSTED' });
        if (name === 'auditLogs' && auditFailure) throw Object.assign(new Error('quota'), { code: 8 });
        return { docs: selected.map(item => ({ id: item.id, data: () => item.data })) };
      },
      async add(data) {
        const id = name === 'reports' ? `report-${++reportId}` : `audit-${++auditId}`;
        records[name].push({ id, data });
        return { id, async get() { return { id, data: () => data }; } };
      },
      doc() {
        const id = `report-${++reportId}`;
        return { id, path: `${name}/${id}` };
      },
    };
    return query;
  },
  doc(path) {
    if (path === 'recordIdCounters/reports') return { id: 'reports', path };
    throw new Error('Unexpected document read');
  },
  async runTransaction(callback) {
    const writes = [];
    const transaction = {
      async get(reference) {
        if (reference.path === 'recordIdCounters/reports') {
          return { exists: reportDisplayId > 0, data: () => ({ lastIssued: reportDisplayId }) };
        }
        return { exists: false, data: () => undefined };
      },
      set(reference, data) { writes.push(['counter', reference, data]); },
      create(reference, data) { writes.push(['report', reference, data]); },
    };
    const result = await callback(transaction);
    for (const [kind, reference, data] of writes) {
      if (kind === 'counter') reportDisplayId = data.lastIssued;
      else records.reports.push({ id: reference.id, data });
    }
    return result;
  },
};

require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db } };
require.cache[require.resolve('../dist/middleware/auth')] = {
  exports: {
    requireAuth(req, _res, next) { req.user = { uid: 'admin', role, barangayId: 'wawa', name: 'Admin', email: 'admin@example.com' }; next(); },
    requireOfficial(_req, _res, next) { next(); },
  },
};

const app = express();
app.use(express.json());
app.use('/reports', require('../dist/routes/reports').default);
app.use('/audit-logs', require('../dist/routes/auditLogs').default);
app.use('/dashboard', require('../dist/routes/dashboard').default);
let server;
let base;
before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('repeated report and audit list calls reuse scoped reads without changing response envelopes', async () => {
  reads = { reports: 0, auditLogs: 0 };
  const reports1 = await (await fetch(`${base}/reports`)).json();
  const reports2 = await (await fetch(`${base}/reports`)).json();
  assert.deepEqual(reports1, reports2);
  assert.deepEqual(reports1.data[0], { id: 'report-1', ...records.reports[0].data });
  assert.equal(reads.reports, 1);

  const reportReadsBeforeDashboard = reads.reports;
  assert.equal((await fetch(`${base}/dashboard`)).status, 200);
  assert.equal(reads.reports, reportReadsBeforeDashboard);

  const logs1 = await (await fetch(`${base}/audit-logs`)).json();
  const logs2 = await (await fetch(`${base}/audit-logs`)).json();
  assert.deepEqual(logs1, logs2);
  assert.equal(logs1.data.length, 1);
  assert.equal(reads.auditLogs, 1);
});

test('different barangay scopes do not share report data', async () => {
  role = 'BARANGAY_OFFICIAL';
  const response = await fetch(`${base}/reports`);
  const { data } = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.length, 1);
  assert.equal(reads.reports, 2);
  role = 'LGU_ADMIN';
});

test('report and audit writes invalidate cached lists', async () => {
  const response = await fetch(`${base}/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'flood', location: 'Wawa', description: 'Road flooding' }),
  });
  assert.equal(response.status, 201);
  assert.equal(reads.reports, 2);

  const reportList = await fetch(`${base}/reports`);
  assert.equal((await reportList.json()).data.length, 2);
  assert.equal(reads.reports, 3);

  const logReadsBefore = reads.auditLogs;
  await fetch(`${base}/audit-logs`);
  assert.equal(reads.auditLogs, logReadsBefore + 1);
});

test('RESOURCE_EXHAUSTED returns retryable 503s and is not retried by the backend', async () => {
  const { invalidateReportReads } = require('../dist/services/reportReads');
  const { invalidateFirestoreReadCache } = require('../dist/services/firestoreReadCache');
  invalidateReportReads();
  reportFailure = true;
  const before = reads.reports;
  const first = await fetch(`${base}/reports`);
  const second = await fetch(`${base}/reports`);
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('retry-after'), '5');
  assert.equal(second.status, 503);
  assert.equal(reads.reports - before, 2);
  reportFailure = false;

  invalidateFirestoreReadCache('auditLogs:');
  auditFailure = true;
  const auditReadsBefore = reads.auditLogs;
  const auditResponse = await fetch(`${base}/audit-logs`);
  assert.equal(auditResponse.status, 503);
  assert.equal(auditResponse.headers.get('retry-after'), '5');
  assert.equal(reads.auditLogs, auditReadsBefore + 1);
  auditFailure = false;
});
