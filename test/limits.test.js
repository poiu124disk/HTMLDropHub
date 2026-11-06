import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdh-limits-'));
const configPath = path.join(tmpDir, 'config.json');

// Use a dedicated config so the tests are independent of the user's settings.
// 0.01 MB = 10240 bytes.
fs.writeFileSync(
  configPath,
  JSON.stringify({
    limits: {
      allowedExtensions: ['.html'],
      maxFileSizeMb: 0.01,
      maxScopeSizeMb: 0.01,
      maxScopeFileCount: 3
    }
  }, null, 2),
  'utf8'
);

process.env.CONFIG_FILE = configPath;
process.env.DATA_DIR = path.join(tmpDir, 'data');

const { saveAppFile } = await import('../src/services/storage.js');
const { sanitizeFilename } = await import('../src/auth/security.js');

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Limits: only configured file extensions are accepted', async () => {
  assert.equal(sanitizeFilename('page.html'), 'page.html');
  assert.throws(() => sanitizeFilename('page.htm'), /Invalid file extension/);

  await assert.rejects(
    saveAppFile('ext_scope', 'page.htm', '<h1>not allowed</h1>'),
    /Invalid file extension/
  );
});

test('Limits: single file size limit is enforced', async () => {
  const oversized = `<!--${'x'.repeat(11000)}-->`;

  await assert.rejects(
    saveAppFile('file_size_scope', 'big.html', oversized, { maxFileSizeMb: 1 }),
    /exceeds the maximum allowed limit/
  );

  const saved = await saveAppFile('file_size_scope', 'small.html', '<h1>ok</h1>');
  assert.equal(saved.filename, 'small.html');
});

test('Limits: per-folder file count limit is enforced while updates remain allowed', async () => {
  await saveAppFile('count_scope', 'one.html', '1');
  await saveAppFile('count_scope', 'two.html', '2');
  await saveAppFile('count_scope', 'three.html', '3');

  await assert.rejects(
    saveAppFile('count_scope', 'four.html', '4'),
    /limit is 3 files per folder/
  );

  // Updating an existing file must not consume another slot.
  const updated = await saveAppFile('count_scope', 'one.html', 'updated');
  assert.equal(updated.isUpdate, true);
});

test('Limits: per-folder total size limit is enforced', async () => {
  const fourKb = 'x'.repeat(4000);

  await saveAppFile('size_scope', 'a.html', fourKb);
  await saveAppFile('size_scope', 'b.html', fourKb);

  await assert.rejects(
    saveAppFile('size_scope', 'c.html', fourKb),
    /exceeding the configured limit of 0.01 MB per folder/
  );
});
