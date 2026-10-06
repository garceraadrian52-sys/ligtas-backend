const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

process.env.FIREBASE_PROJECT_ID = 'demo-ligtas-tests';
process.env.ENABLE_NOTIFICATION_WORKERS = 'false';
const { app } = require('../dist/server');
let server;
let base;

before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health reports HTTP availability without claiming a database connection', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.database, 'not_checked');
  assert.equal(data.notificationWorkersEnabled, false);
});

test('private API routes and Firestore diagnostic reject requests without authentication', async () => {
  for (const route of ['/users', '/reports', '/alerts', '/profile', '/notifications', '/test-firestore']) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 401, route);
  }
});

test('login rejects missing input before contacting Firebase', async () => {
  const response = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 400);
});
