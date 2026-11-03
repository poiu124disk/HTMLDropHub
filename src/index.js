import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PORT,
  PUBLIC_BASE_URL,
  ADMIN_PASSWORD,
  APPS_DIR,
  ALLOW_PUBLIC_CATALOG
} from './config.js';

import { resolveSafePath, validateScope, SecurityError } from './auth/security.js';
import { authenticateApiKey, authenticateAdmin } from './auth/authenticator.js';
import { keyStore } from './services/key-store.js';
import { metadataStore } from './services/metadata-store.js';

import { handleSseConnection, handleMessagesPost } from './mcp/server.js';
import { handleDropApi } from './api/drop.js';
import { handleListAppsApi, handleDeleteAppApi } from './api/apps.js';
import {
  handleAdminLogin,
  handleAdminLogout,
  handleAdminOverview,
  handleAdminListKeys,
  handleAdminCreateKey,
  handleAdminUpdateKey,
  handleAdminDeleteKey,
  handleAdminListAllApps,
  handleAdminDeleteApp
} from './admin/admin-api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewsDir = path.join(__dirname, 'views');

const app = express();

// Trust proxy for Cloudflare Tunnel / Reverse Proxies
app.set('trust proxy', 1);

// Middlewares
app.use(cookieParser());
app.use(express.json({ limit: '25mb' }));
app.use(express.text({ type: ['text/html', 'text/plain'], limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

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
    return res.redirect('/admin/login');
  }
  res.sendFile(path.join(viewsDir, 'catalog.html'));
});

// Admin Login View
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(viewsDir, 'login.html'));
});

// Admin Dashboard View (Protected)
app.get('/admin', authenticateAdmin, (req, res) => {
  res.sendFile(path.join(viewsDir, 'admin.html'));
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
// 4. Admin Management API
// ==========================================

app.post('/api/admin/login', handleAdminLogin);
app.post('/api/admin/logout', handleAdminLogout);

// Protected Admin API group
app.get('/api/admin/overview', authenticateAdmin, handleAdminOverview);
app.get('/api/admin/keys', authenticateAdmin, handleAdminListKeys);
app.post('/api/admin/keys', authenticateAdmin, handleAdminCreateKey);
app.patch('/api/admin/keys/:id', authenticateAdmin, handleAdminUpdateKey);
app.delete('/api/admin/keys/:id', authenticateAdmin, handleAdminDeleteKey);
app.get('/api/admin/apps', authenticateAdmin, handleAdminListAllApps);
app.delete('/api/admin/apps', authenticateAdmin, handleAdminDeleteApp);

// ==========================================
// 5. Static Micro-App Dispatcher (Chroot Protected)
// Example: GET /devB/report.html
// ==========================================
app.get('/:scope/:filename', (req, res, next) => {
  try {
    const { scope, filename } = req.params;

    // Disallow reserved paths
    if (['api', 'admin', 'sse', 'messages', 'health'].includes(scope.toLowerCase())) {
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
    // Allow iframe embedding from same origin (for catalog & admin previews)
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
  await keyStore.init();
  await metadataStore.init();

  // If no keys exist at first launch, automatically create a default demo key
  const keys = await keyStore.getAllKeys();
  if (keys.length === 0) {
    const initialKey = await keyStore.createKey({
      name: 'Default_Developer',
      scope: 'demo',
      allowOverwrite: true,
      notes: 'Automatically generated initial developer key'
    });
    console.log(`\n🔑 Initial API Key generated for scope '/demo/':`);
    console.log(`   Token: ${initialKey.token}\n`);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚀 HTMLDropHub Engine running on port ${PORT}`);
    console.log(`👉 App Catalog:    ${PUBLIC_BASE_URL}/`);
    console.log(`👉 Admin Panel:    ${PUBLIC_BASE_URL}/admin (Password: ${ADMIN_PASSWORD})`);
    console.log(`👉 Remote MCP SSE: ${PUBLIC_BASE_URL}/sse?token=<YOUR_TOKEN>`);
    console.log(`👉 REST Drop API:  ${PUBLIC_BASE_URL}/api/drop`);
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
