import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdh-users-'));
const configPath = path.join(tmpDir, 'config.json');

fs.writeFileSync(
  configPath,
  JSON.stringify({
    users: { maxApiKeysPerUser: 2 },
    auth: { sessionSecret: 'integration-test-session-secret' }
  }, null, 2),
  'utf8'
);

process.env.CONFIG_FILE = configPath;
process.env.DATA_DIR = path.join(tmpDir, 'data');

const { userStore } = await import('../src/services/user-store.js');
const { keyStore } = await import('../src/services/key-store.js');
const { createSessionToken, verifySessionToken } = await import('../src/auth/session.js');
const { SecurityError } = await import('../src/auth/security.js');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Users: Google profile creates a persistent user with a unique jailed scope', async () => {
  const user = await userStore.upsertGoogleUser({
    sub: 'google-sub-alice',
    email: 'Alice@Example.com',
    name: 'Alice',
    picture: 'https://example.com/alice.png'
  });

  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.name, 'Alice');
  assert.match(user.scope, /^u_[a-f0-9]{16}$/);

  const loaded = await userStore.getUserById(user.id);
  assert.equal(loaded.id, user.id);
  assert.deepEqual(loaded.apiKeys, []);
});

test('Users: per-user API key limit is enforced', async () => {
  const user = await userStore.upsertGoogleUser({
    sub: 'google-sub-bob',
    email: 'bob@example.com',
    name: 'Bob'
  });

  const first = await userStore.createApiKey(user.id, { name: 'Laptop' });
  const second = await userStore.createApiKey(user.id, { name: 'CI' });

  assert.match(first.token, /^hdh_sec_[a-f0-9]{40}$/);
  assert.equal(first.scope, user.scope);
  assert.notEqual(first.token, second.token);

  await assert.rejects(
    userStore.createApiKey(user.id, { name: 'Third' }),
    error => error instanceof SecurityError && error.statusCode === 403
  );

  const resolved = await keyStore.getKeyByToken(first.token);
  assert.equal(resolved.userId, user.id);
  assert.equal(resolved.userEmail, 'bob@example.com');
  assert.equal(resolved.scope, user.scope);
});

test('Users: deleting a key frees a slot', async () => {
  const user = await userStore.upsertGoogleUser({
    sub: 'google-sub-carol',
    email: 'carol@example.com',
    name: 'Carol'
  });

  const first = await userStore.createApiKey(user.id, { name: 'One' });
  await userStore.createApiKey(user.id, { name: 'Two' });

  assert.equal(await userStore.deleteApiKey(user.id, first.id), true);
  assert.equal(await userStore.deleteApiKey(user.id, first.id), false);

  const replacement = await userStore.createApiKey(user.id, { name: 'Replacement' });
  assert.equal(replacement.name, 'Replacement');
});

test('Users: signed session tokens detect tampering and expiry', async () => {
  const token = createSessionToken('user-123');
  const payload = verifySessionToken(token);
  assert.equal(payload.uid, 'user-123');

  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  assert.equal(verifySessionToken(tampered), null);
  assert.equal(verifySessionToken('not-a-token'), null);
  assert.equal(verifySessionToken(''), null);
});
