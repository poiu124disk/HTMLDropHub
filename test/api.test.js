import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../src/index.js';
import { keyStore } from '../src/services/key-store.js';
import { metadataStore } from '../src/services/metadata-store.js';
import { ADMIN_PASSWORD } from '../src/config.js';

let server;
let baseUrl;
let testKey;

test.before(async () => {
  await keyStore.init();
  await metadataStore.init();

  testKey = await keyStore.createKey({
    name: 'IntegrationTest_Dev',
    scope: 'api_test_scope',
    allowOverwrite: true,
    maxFileSizeMb: 2
  });

  await new Promise(resolve => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
});

test('API: /health returns ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'HTMLDropHub');
});

test('API: /api/drop rejects unauthorized requests', async () => {
  const res = await fetch(`${baseUrl}/api/drop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'test.html', content: '<h1>Hi</h1>' })
  });
  assert.equal(res.status, 401);
});

test('API: /api/drop deploys micro-app with valid Bearer token', async () => {
  const res = await fetch(`${baseUrl}/api/drop`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${testKey.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename: 'sales.html',
      title: 'Sales Dashboard',
      description: 'Q4 numbers',
      content: '<!DOCTYPE html><html><head><title>Sales Dashboard</title></head><body><h1>Sales 2026</h1></body></html>'
    })
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.data.scope, 'api_test_scope');
  assert.equal(data.data.filename, 'sales.html');

  // Verify static serve
  const staticRes = await fetch(`${baseUrl}/api_test_scope/sales.html`);
  assert.equal(staticRes.status, 200);
  const html = await staticRes.text();
  assert.ok(html.includes('Sales 2026'));
});

test('API: /api/drop blocks path traversal attempts', async () => {
  const res = await fetch(`${baseUrl}/api/drop`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${testKey.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename: '../escaped.html',
      content: '<h1>Bad</h1>'
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, 'Security Error');
});

test('API: Admin authentication and overview', async () => {
  // Login
  const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD })
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie');
  assert.ok(cookie);

  // Overview with cookie
  const overviewRes = await fetch(`${baseUrl}/api/admin/overview`, {
    headers: { 'Cookie': cookie }
  });
  assert.equal(overviewRes.status, 200);
  const overviewData = await overviewRes.json();
  assert.equal(overviewData.success, true);
  assert.ok(overviewData.stats.totalApps >= 1);
});
