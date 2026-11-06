import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../src/index.js';
import { keyStore } from '../src/services/key-store.js';
import { metadataStore } from '../src/services/metadata-store.js';
import { userStore } from '../src/services/user-store.js';
import { createSessionToken } from '../src/auth/session.js';

let server;
let baseUrl;
let testKey;
let testUserId = null;

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
  if (testUserId) {
    await userStore.deleteUser(testUserId);
  }
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

test('API: /admin and /api/admin/* are no longer available', async () => {
  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 404);

  const adminApi = await fetch(`${baseUrl}/api/admin/overview`);
  assert.equal(adminApi.status, 404);
});

test('API: /api/session reports an anonymous visitor', async () => {
  const res = await fetch(`${baseUrl}/api/session`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.authenticated, false);
});

test('API: Google login explains missing OAuth configuration', async () => {
  const res = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not configured/);
});

test('API: /api/me requires a Google session', async () => {
  const res = await fetch(`${baseUrl}/api/me`);
  assert.equal(res.status, 401);
});

test('API: signed-in user can create and delete their own API keys', async () => {
  const user = await userStore.upsertGoogleUser({
    sub: 'api-test-google-user',
    email: 'api-test@example.com',
    name: 'API Test'
  });
  testUserId = user.id;

  // Keep the test idempotent across repeated runs.
  const existing = await userStore.getUserById(user.id);
  for (const key of existing.apiKeys) {
    await userStore.deleteApiKey(user.id, key.id);
  }

  const cookie = `hdh_session=${encodeURIComponent(createSessionToken(user.id))}`;

  const meRes = await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(meRes.status, 200);
  const me = await meRes.json();
  assert.equal(me.user.email, 'api-test@example.com');
  assert.equal(me.keyCount, 0);

  const dashboardRes = await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(dashboardRes.status, 200);
  assert.match(await dashboardRes.text(), /API Keys/);

  const anonymousDashboard = await fetch(`${baseUrl}/dashboard`, { redirect: 'manual' });
  assert.equal(anonymousDashboard.status, 302);
  assert.match(anonymousDashboard.headers.get('location') || '', /\/auth\/google/);

  const createRes = await fetch(`${baseUrl}/api/me/keys`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Key' })
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.key.scope, user.scope);
  assert.match(created.key.configs.sseUrl, /\/sse\?token=/);

  const deleteRes = await fetch(`${baseUrl}/api/me/keys/${created.key.id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie }
  });
  assert.equal(deleteRes.status, 200);
});

test('API: /api/drop enforces configured extension whitelist', async () => {
  const res = await fetch(`${baseUrl}/api/drop`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${testKey.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      filename: 'not-allowed.txt',
      content: 'plain text'
    })
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, 'Security Error');
});
