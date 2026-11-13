const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const express = require('express');

// Route-contract checks never initialize the production Admin SDK.
require.cache[require.resolve('../dist/config/firebaseAdmin')] = { exports: { db: {}, auth: {} } };
const app = express();
app.use(express.json());
app.use('/households', require('../dist/routes/households').default);
app.use(require('../dist/middleware/errorHandler').notFound);
let server, base;
before(async () => {
  server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

for (const [method, path] of [
  ['POST', '/households/preview'], ['POST', '/households/join'],
  ['PATCH', '/households/H-ABCDE/details'],
  ['POST', '/households/requests/H-ABCDE_resident/decision'],
  ['POST', '/households'], ['POST', '/households/H-ABCDE/reference'],
  ['POST', '/households/resolve'],
]) {
  test(`${method} ${path} is registered and requires authentication`, async () => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await response.json();
    assert.equal(response.status, 401, JSON.stringify(body));
    assert.equal(body.error, 'Missing or invalid Authorization header.');
  });
}
