import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  APPS_DIR,
  MAX_FILE_SIZE_MB,
  MAX_SCOPE_SIZE_MB,
  MAX_SCOPE_FILE_COUNT
} from '../config.js';
import { validateScope, resolveSafePath, SecurityError } from '../auth/security.js';

/**
 * Ensures scope folder exists within APPS_DIR
 */
export async function getScopeDir(scope) {
  const safeScope = validateScope(scope);
  const scopeDir = path.join(APPS_DIR, safeScope);
  if (!fsSync.existsSync(scopeDir)) {
    await fs.mkdir(scopeDir, { recursive: true });
  }
  return scopeDir;
}

/**
 * Measures current disk usage of a scope folder.
 * Hidden files (including atomic-write temp files) are ignored.
 */
async function getScopeUsage(scopeDir) {
  const entries = await fs.readdir(scopeDir, { withFileTypes: true });
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const stat = await fs.stat(path.join(scopeDir, entry.name));
    totalBytes += stat.size;
    fileCount++;
  }

  return { totalBytes, fileCount };
}

function formatMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

/**
 * Saves HTML content to a scope directory with atomic write and chroot enforcement.
 * Enforces per-file size, per-folder total size, and per-folder file count limits.
 */
export async function saveAppFile(scope, rawFilename, content, options = {}) {
  const { allowOverwrite = true, maxFileSizeMb = MAX_FILE_SIZE_MB } = options;
  const scopeDir = await getScopeDir(scope);
  const { resolvedPath, filename } = resolveSafePath(scopeDir, rawFilename);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

  // Enforce per-file size limit (global cap applies even if a key requests more)
  const effectiveMaxFileSizeMb = Math.min(
    Number(maxFileSizeMb) > 0 ? Number(maxFileSizeMb) : MAX_FILE_SIZE_MB,
    MAX_FILE_SIZE_MB
  );
  const maxFileBytes = effectiveMaxFileSizeMb * 1024 * 1024;
  if (buffer.length > maxFileBytes) {
    throw new SecurityError(
      `File size (${formatMb(buffer.length)} MB) exceeds the maximum allowed limit (${effectiveMaxFileSizeMb} MB).`,
      413
    );
  }

  // Check overwrite permission
  const exists = fsSync.existsSync(resolvedPath);
  if (exists && !allowOverwrite) {
    throw new SecurityError(
      `File '${filename}' already exists and overwrite is disabled for this key.`,
      409
    );
  }

  // Enforce per-folder file count and total size limits
  const usage = await getScopeUsage(scopeDir);
  const existingBytes = exists ? (await fs.stat(resolvedPath)).size : 0;
  const nextFileCount = usage.fileCount + (exists ? 0 : 1);
  const nextTotalBytes = usage.totalBytes - existingBytes + buffer.length;

  if (nextFileCount > MAX_SCOPE_FILE_COUNT) {
    throw new SecurityError(
      `Folder '${scope}' already contains ${usage.fileCount} files. ` +
      `The configured limit is ${MAX_SCOPE_FILE_COUNT} files per folder.`,
      413
    );
  }

  const maxScopeBytes = MAX_SCOPE_SIZE_MB * 1024 * 1024;
  if (nextTotalBytes > maxScopeBytes) {
    throw new SecurityError(
      `Folder '${scope}' would use ${formatMb(nextTotalBytes)} MB after this upload, ` +
      `exceeding the configured limit of ${MAX_SCOPE_SIZE_MB} MB per folder.`,
      413
    );
  }

  // Atomic write via temp file (with Windows EPERM fallback)
  const tempPath = path.join(scopeDir, `.__tmp_${crypto.randomUUID()}`);
  await fs.writeFile(tempPath, buffer);
  try {
    await fs.rename(tempPath, resolvedPath);
  } catch (err) {
    if (['EPERM', 'EEXIST', 'EBUSY'].includes(err.code)) {
      await fs.copyFile(tempPath, resolvedPath);
      await fs.unlink(tempPath).catch(() => {});
    } else {
      await fs.unlink(tempPath).catch(() => {});
      throw err;
    }
  }

  return {
    filename,
    resolvedPath,
    sizeBytes: buffer.length,
    isUpdate: exists
  };
}

/**
 * Deletes an app file inside a scope
 */
export async function deleteAppFile(scope, rawFilename) {
  const scopeDir = await getScopeDir(scope);
  const { resolvedPath, filename } = resolveSafePath(scopeDir, rawFilename);

  if (fsSync.existsSync(resolvedPath)) {
    await fs.unlink(resolvedPath);
    return { success: true, filename };
  }
  return { success: false, notFound: true, filename };
}

/**
 * Lists files physically existing inside a scope directory
 */
export async function listAppFiles(scope) {
  const scopeDir = await getScopeDir(scope);
  const entries = await fs.readdir(scopeDir, { withFileTypes: true });

  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith('.')) {
      const filePath = path.join(scopeDir, entry.name);
      const stat = await fs.stat(filePath);
      files.push({
        filename: entry.name,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
  }
  return files;
}
