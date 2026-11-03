import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPS_DIR, MAX_FILE_SIZE_MB } from '../config.js';
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
 * Saves HTML content to a scope directory with atomic write and chroot enforcement
 */
export async function saveAppFile(scope, rawFilename, content, options = {}) {
  const { allowOverwrite = true, maxFileSizeMb = MAX_FILE_SIZE_MB } = options;
  const scopeDir = await getScopeDir(scope);
  const { resolvedPath, filename } = resolveSafePath(scopeDir, rawFilename);

  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');

  // Enforce size limit
  const maxBytes = maxFileSizeMb * 1024 * 1024;
  if (buffer.length > maxBytes) {
    throw new SecurityError(`File size (${(buffer.length / 1024 / 1024).toFixed(2)} MB) exceeds maximum allowed limit (${maxFileSizeMb} MB).`, 413);
  }

  // Check overwrite permission
  const exists = fsSync.existsSync(resolvedPath);
  if (exists && !allowOverwrite) {
    throw new SecurityError(`File '${filename}' already exists and overwrite is disabled for this key.`, 409);
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
