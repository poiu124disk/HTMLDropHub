import path from 'node:path';
import { ALLOWED_EXTENSIONS } from '../config.js';

export class SecurityError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SecurityError';
    this.statusCode = statusCode;
  }
}

/**
 * Validates scope / folder name (e.g., 'devA', 'finance_team')
 */
export function validateScope(scope) {
  if (!scope || typeof scope !== 'string') {
    throw new SecurityError('Scope name is required and must be a string.', 400);
  }
  const trimmed = scope.trim();
  if (trimmed.length < 1 || trimmed.length > 64) {
    throw new SecurityError('Scope name must be between 1 and 64 characters.', 400);
  }
  // Alphanumeric, underscores, hyphens only
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new SecurityError('Scope name can only contain letters, numbers, underscores, and hyphens.', 400);
  }
  return trimmed;
}

/**
 * Sanitizes and validates a filename
 */
export function sanitizeFilename(rawFilename) {
  if (!rawFilename || typeof rawFilename !== 'string') {
    throw new SecurityError('Filename is required and must be a string.', 400);
  }

  const trimmed = rawFilename.trim();

  // Reject path separators and null bytes immediately
  if (/[\/\\\x00]/.test(trimmed)) {
    throw new SecurityError('Filename must not contain path separators or null bytes.', 400);
  }

  // Reject directory traversal patterns
  if (trimmed === '.' || trimmed === '..' || trimmed.startsWith('..')) {
    throw new SecurityError('Directory traversal sequences are forbidden.', 400);
  }

  // Reject hidden files (e.g., .env, .htaccess)
  if (trimmed.startsWith('.')) {
    throw new SecurityError('Hidden files (starting with dot) are forbidden.', 400);
  }

  // Validate allowed characters: alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(trimmed)) {
    throw new SecurityError('Filename contains invalid characters.', 400);
  }

  // Enforce configured extensions (case-insensitive)
  const lower = trimmed.toLowerCase();
  const hasValidExt = ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext));
  if (!hasValidExt) {
    throw new SecurityError(
      `Invalid file extension. Only ${ALLOWED_EXTENSIONS.join(', ')} are permitted.`,
      400
    );
  }

  return trimmed;
}

/**
 * Resolves a safe filesystem path guaranteed to be trapped inside rootScopeDir
 */
export function resolveSafePath(rootScopeDir, filename) {
  const safeFilename = sanitizeFilename(filename);
  const normalizedRoot = path.resolve(rootScopeDir);
  const resolved = path.resolve(normalizedRoot, safeFilename);

  // Chroot jail boundary check
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityError('Path traversal jail violation detected.', 403);
  }

  return {
    resolvedPath: resolved,
    filename: safeFilename
  };
}

/**
 * Helper to extract HTML <title> and <meta name="description">
 */
export function extractHtmlMetadata(htmlContent, fallbackFilename) {
  if (typeof htmlContent !== 'string') {
    return {
      title: fallbackFilename,
      description: ''
    };
  }

  let title = '';
  let description = '';

  const titleMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].trim();
  }

  const descMatch = htmlContent.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
                    htmlContent.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  if (descMatch && descMatch[1]) {
    description = descMatch[1].trim();
  }

  if (!title) {
    // Generate readable title from filename, e.g. "sales-report.html" -> "Sales Report"
    const base = fallbackFilename.replace(/\.[^/.]+$/, '');
    title = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  return {
    title: title.slice(0, 100),
    description: description.slice(0, 300)
  };
}
