import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateScope, sanitizeFilename, resolveSafePath, extractHtmlMetadata, SecurityError } from '../src/auth/security.js';

test('Security: validateScope accepts valid scopes and rejects dangerous ones', () => {
  // Valid
  assert.equal(validateScope('alice'), 'alice');
  assert.equal(validateScope('dev_team-1'), 'dev_team-1');
  assert.equal(validateScope('finance2026'), 'finance2026');

  // Traversal & illegal characters
  assert.throws(() => validateScope(''), SecurityError);
  assert.throws(() => validateScope('../alice'), SecurityError);
  assert.throws(() => validateScope('alice/bob'), SecurityError);
  assert.throws(() => validateScope('alice\\bob'), SecurityError);
  assert.throws(() => validateScope('alice.bob'), SecurityError);
  assert.throws(() => validateScope('alice?key=1'), SecurityError);
  assert.throws(() => validateScope('alice;rm -rf'), SecurityError);
  assert.throws(() => validateScope('alice\0null'), SecurityError);
});

test('Security: sanitizeFilename permits only safe html filenames', () => {
  // Valid
  assert.equal(sanitizeFilename('report.html'), 'report.html');
  assert.equal(sanitizeFilename('chart_2026-03.htm'), 'chart_2026-03.htm');
  assert.equal(sanitizeFilename('index.v1.0.html'), 'index.v1.0.html');

  // Traversal sequences
  assert.throws(() => sanitizeFilename('..'), SecurityError);
  assert.throws(() => sanitizeFilename('../report.html'), SecurityError);
  assert.throws(() => sanitizeFilename('..\\report.html'), SecurityError);
  assert.throws(() => sanitizeFilename('folder/report.html'), SecurityError);

  // Hidden files
  assert.throws(() => sanitizeFilename('.env.html'), SecurityError);
  assert.throws(() => sanitizeFilename('.htaccess'), SecurityError);

  // Prohibited extensions
  assert.throws(() => sanitizeFilename('script.js'), SecurityError);
  assert.throws(() => sanitizeFilename('payload.exe'), SecurityError);
  assert.throws(() => sanitizeFilename('exploit.php'), SecurityError);
  assert.throws(() => sanitizeFilename('run.sh'), SecurityError);

  // Null byte injection
  assert.throws(() => sanitizeFilename('report.html\0.exe'), SecurityError);
});

test('Security: resolveSafePath prevents jail escapes', () => {
  const fakeScopeDir = path.resolve('/var/data/apps/userA');

  const { resolvedPath, filename } = resolveSafePath(fakeScopeDir, 'dashboard.html');
  assert.equal(filename, 'dashboard.html');
  assert.equal(resolvedPath, path.resolve(fakeScopeDir, 'dashboard.html'));

  // Traversal inside filename attempt
  assert.throws(() => resolveSafePath(fakeScopeDir, '../../etc/passwd.html'), SecurityError);
});

test('Security: extractHtmlMetadata correctly parses title and meta description', () => {
  const sampleHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="description" content="A powerful AI analytics widget">
      <title>Q3 Financial Summary</title>
    </head>
    <body><h1>Hello</h1></body>
    </html>
  `;

  const meta = extractHtmlMetadata(sampleHtml, 'fallback.html');
  assert.equal(meta.title, 'Q3 Financial Summary');
  assert.equal(meta.description, 'A powerful AI analytics widget');

  // Fallback title generation when tags missing
  const plainHtml = '<div>Raw Content</div>';
  const plainMeta = extractHtmlMetadata(plainHtml, 'monthly-sales-report.html');
  assert.equal(plainMeta.title, 'Monthly Sales Report');
});
