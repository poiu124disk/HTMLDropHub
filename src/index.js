import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PORT,
  PUBLIC_BASE_URL,
  CONFIG_FILE,
  APPS_DIR,
  ALLOW_PUBLIC_CATALOG,
  TRUST_PROXY,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_MB,
  MAX_SCOPE_SIZE_MB,
  MAX_SCOPE_FILE_COUNT,
  MAX_API_KEYS_PER_USER,
  GOOGLE_AUTH_ENABLED
} from './config.js';

import { resolveSafePath, validateScope, SecurityError } from './auth/security.js';
import { authenticateApiKey } from './auth/authenticator.js';
import { authenticateUser, optionalUser } from './auth/user-auth.js';
import { handleGoogleLogin, handleGoogleCallback, handleLogout } from './auth/google-oauth.js';
import { keyStore } from './services/key-store.js';
import { userStore } from './services/user-store.js';
import { metadataStore } from './services/metadata-store.js';

import { handleSseConnection, handleMessagesPost } from './mcp/server.js';
import { handleDropApi } from './api/drop.js';
import { handleListAppsApi, handleDeleteAppApi } from './api/apps.js';
import { handleGetMe, handleCreateMyKey, handleDeleteMyKey } from './api/me.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewsDir = path.join(__dirname, 'views');

const app = express();

// Trust proxy for Cloudflare Tunnel / Reverse Proxies
if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// Middlewares
// Allow enough room for a file that is within the configured size limits,
// plus a small margin for JSON metadata and encoding overhead.
const bodyLimit = `${Math.ceil(Math.max(MAX_FILE_SIZE_MB, MAX_SCOPE_SIZE_MB)) + 2}mb`;
app.use(express.json({ limit: bodyLimit }));
app.use(express.text({ type: ['text/html', 'text/plain'], limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'HTMLDropHub',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ==========================================
// 1. Static Web Views
// ==========================================

// Catalog Homepage
app.get('/', (req, res) => {
  if (!ALLOW_PUBLIC_CATALOG) {
    return res.status(403).send('<h1>Catalog Disabled</h1><p>The public catalog is disabled in the configuration file.</p>');
  }
  res.sendFile(path.join(viewsDir, 'catalog.html'));
});

// ==========================================
// 1b. User Authentication & Dashboard
// ==========================================

// Session-bound pages and API responses must never be cached by shared proxies.
app.use(['/dashboard', '/api/session', '/api/me'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/login', (req, res) => res.redirect('/auth/google'));
app.get('/auth/google', handleGoogleLogin);
app.get('/auth/google/callback', handleGoogleCallback);
app.post('/auth/logout', handleLogout);

app.get('/dashboard', authenticateUser, (req, res) => {
  res.sendFile(path.join(viewsDir, 'dashboard.html'));
});

app.get('/api/session', optionalUser, (req, res) => {
  if (!req.user) {
    return res.json({ authenticated: false });
  }

  return res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      picture: req.user.picture,
      scope: req.user.scope
    }
  });
});

// ==========================================
// 2. Remote MCP (SSE & Streamable Messages)
// ==========================================

// GET /sse - Establishes SSE stream connection for Cursor, Claude, etc.
app.get('/sse', authenticateApiKey, handleSseConnection);

// POST /messages - Receives client MCP requests for the established session
app.post('/messages', handleMessagesPost);

// ==========================================
// 3. REST API (cURL & Automation)
// ==========================================

// POST /api/drop - Deploy / Update micro-app
app.post('/api/drop', authenticateApiKey, handleDropApi);

// GET /api/apps - List hosted applications
app.get('/api/apps', async (req, res, next) => {
  // Optional auth: if token provided, scope to that key; otherwise show public list
  const token = req.query.token || (req.headers['authorization']?.startsWith('Bearer ') && req.headers['authorization'].slice(7));
  if (token) {
    return authenticateApiKey(req, res, () => handleListAppsApi(req, res));
  }
  return handleListAppsApi(req, res);
});

// DELETE /api/apps/:filename - Delete app within user's scope
app.delete('/api/apps/:filename', authenticateApiKey, handleDeleteAppApi);

// ==========================================
// 3b. Signed-In User API (API key management)
// ==========================================

app.get('/api/me', authenticateUser, handleGetMe);
app.post('/api/me/keys', authenticateUser, handleCreateMyKey);
app.delete('/api/me/keys/:id', authenticateUser, handleDeleteMyKey);

// ==========================================
// 4. Static Micro-App Dispatcher (Chroot Protected)
// Example: GET /devB/report.html
// ==========================================
app.get('/:scope/:filename', (req, res, next) => {
  try {
    const { scope, filename } = req.params;

    // Disallow reserved paths
    if (['api', 'auth', 'admin', 'dashboard', 'login', 'sse', 'messages', 'health'].includes(scope.toLowerCase())) {
      return next();
    }

    // Verify scope and filename
    const safeScope = validateScope(scope);
    const scopeDir = path.join(APPS_DIR, safeScope);

    if (!fs.existsSync(scopeDir)) {
      return res.status(404).send('<h1>404 Not Found</h1><p>Scope folder does not exist.</p>');
    }

    const { resolvedPath } = resolveSafePath(scopeDir, filename);

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).send('<h1>404 Not Found</h1><p>Micro-app file not found.</p>');
    }

    // Send the HTML file with appropriate security headers
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Allow iframe embedding from same origin (for catalog previews)
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    return res.sendFile(resolvedPath);
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 403).send(`<h1>Forbidden</h1><p>${err.message}</p>`);
    }
    return next(err);
  }
});

// 404 Fallback
app.use((req, res) => {
  if (req.accepts('json')) {
    return res.status(404).json({ error: 'Not Found', path: req.originalUrl });
  }
  return res.status(404).send('<h1>404 Not Found</h1>');
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  if (res.headersSent) return next(err);
  if (err instanceof SecurityError) {
    return res.status(err.statusCode || 400).json({ error: 'Security Violation', message: err.message });
  }
  return res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

// Initialization
async function startServer() {
  await userStore.init();
  await keyStore.init();
  await metadataStore.init();

  const keys = await keyStore.getAllKeys();
  if (keys.length === 0) {
    console.warn('[Startup] No API keys are configured. Add entries to "apiKeys" in the config file or sign in with Google.');
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 HTMLDropHub Engine running on port ${PORT}`);
    console.log(`👉 App Catalog:    ${PUBLIC_BASE_URL}/`);
    console.log(`👉 Remote MCP SSE: ${PUBLIC_BASE_URL}/sse?token=<YOUR_TOKEN>`);
    console.log(`👉 REST Drop API:  ${PUBLIC_BASE_URL}/api/drop`);
    console.log(`⚙️  Config File:    ${CONFIG_FILE}`);
    console.log(`📏 Limits:         ${ALLOWED_EXTENSIONS.join(', ')} | ${MAX_FILE_SIZE_MB} MB/file | ${MAX_SCOPE_SIZE_MB} MB/folder | ${MAX_SCOPE_FILE_COUNT} files/folder`);
    console.log(`👤 Users:          ${MAX_API_KEYS_PER_USER} API key(s)/user | Google login: ${GOOGLE_AUTH_ENABLED ? 'configured' : 'NOT configured'}`);
    console.log(`====================================================`);
  });
}

// Start only if run directly as script
const isDirectRun = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

if (isDirectRun && process.env.NODE_ENV !== 'test') {
  startServer().catch(err => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}

export { app, startServer };
