import os from 'node:os';
import { PUBLIC_BASE_URL, ADMIN_PASSWORD } from '../config.js';
import { verifyAdminPassword, getAdminSessionSecret } from '../auth/authenticator.js';
import { keyStore } from '../services/key-store.js';
import { metadataStore } from '../services/metadata-store.js';
import { deleteAppFile } from '../services/storage.js';
import { SecurityError } from '../auth/security.js';

/**
 * Generates ready-to-copy client configurations for Cursor, Claude Desktop, and cURL
 */
export function generateClientConfigs(key) {
  const sseUrl = `${PUBLIC_BASE_URL}/sse?token=${key.token}`;

  const cursorConfig = {
    mcpServers: {
      [`htmldrophub-${key.scope}`]: {
        url: sseUrl
      }
    }
  };

  const claudeDesktopConfig = {
    mcpServers: {
      [`htmldrophub-${key.scope}`]: {
        url: sseUrl
      }
    }
  };

  const curlExample = `curl -X POST "${PUBLIC_BASE_URL}/api/drop" \\
  -H "Authorization: Bearer ${key.token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "filename": "hello.html",
    "title": "My First Micro-App",
    "description": "Created via API",
    "content": "<!DOCTYPE html><html><body><h1>Hello from HTMLDropHub!</h1></body></html>"
  }'`;

  return {
    sseUrl,
    cursorJson: JSON.stringify(cursorConfig, null, 2),
    claudeDesktopJson: JSON.stringify(claudeDesktopConfig, null, 2),
    curlExample
  };
}

/**
 * POST /api/admin/login
 */
export async function handleAdminLogin(req, res) {
  const { password } = req.body || {};
  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ success: false, message: 'Invalid admin password' });
  }

  const sessionToken = getAdminSessionSecret();
  res.cookie('hdh_admin_session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });

  return res.json({ success: true, message: 'Admin authenticated successfully' });
}

/**
 * POST /api/admin/logout
 */
export async function handleAdminLogout(req, res) {
  res.clearCookie('hdh_admin_session', { path: '/' });
  return res.json({ success: true, message: 'Logged out successfully' });
}

/**
 * GET /api/admin/overview
 */
export async function handleAdminOverview(req, res) {
  try {
    const keys = await keyStore.getAllKeys();
    const apps = await metadataStore.getAllApps();

    const totalStorageBytes = apps.reduce((sum, app) => sum + (app.sizeBytes || 0), 0);
    const activeKeysCount = keys.filter(k => k.enabled).length;

    const scopesSet = new Set(apps.map(a => a.scope));

    return res.json({
      success: true,
      stats: {
        totalApps: apps.length,
        totalScopes: scopesSet.size,
        totalKeys: keys.length,
        activeKeys: activeKeysCount,
        storageBytes: totalStorageBytes,
        storageFormatted: `${(totalStorageBytes / 1024 / 1024).toFixed(2)} MB`,
        publicBaseUrl: PUBLIC_BASE_URL,
        nodeVersion: process.version,
        platform: os.platform(),
        uptimeSeconds: Math.floor(process.uptime())
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve stats', message: err.message });
  }
}

/**
 * GET /api/admin/keys
 */
export async function handleAdminListKeys(req, res) {
  try {
    const keys = await keyStore.getAllKeys();
    const formatted = keys.map(k => ({
      ...k,
      configs: generateClientConfigs(k)
    }));
    return res.json({ success: true, keys: formatted });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list keys', message: err.message });
  }
}

/**
 * POST /api/admin/keys
 */
export async function handleAdminCreateKey(req, res) {
  try {
    const { name, scope, token, allowOverwrite, maxFileSizeMb, enabled, notes } = req.body || {};
    const created = await keyStore.createKey({
      name,
      scope,
      token,
      allowOverwrite,
      maxFileSizeMb,
      enabled,
      notes
    });

    const configs = generateClientConfigs(created);

    return res.status(201).json({
      success: true,
      message: `API Key '${created.name}' created successfully`,
      key: {
        ...created,
        configs
      }
    });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({ error: 'Validation Error', message: err.message });
    }
    return res.status(500).json({ error: 'Failed to create key', message: err.message });
  }
}

/**
 * PATCH /api/admin/keys/:id
 */
export async function handleAdminUpdateKey(req, res) {
  try {
    const id = req.params.id;
    const updates = req.body || {};
    const updated = await keyStore.updateKey(id, updates);

    return res.json({
      success: true,
      message: 'API Key updated successfully',
      key: {
        ...updated,
        configs: generateClientConfigs(updated)
      }
    });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({ error: 'Validation Error', message: err.message });
    }
    return res.status(500).json({ error: 'Failed to update key', message: err.message });
  }
}

/**
 * DELETE /api/admin/keys/:id
 */
export async function handleAdminDeleteKey(req, res) {
  try {
    const id = req.params.id;
    const deleted = await keyStore.deleteKey(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Key not found' });
    }
    return res.json({ success: true, message: 'API Key revoked and deleted successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete key', message: err.message });
  }
}

/**
 * GET /api/admin/apps
 */
export async function handleAdminListAllApps(req, res) {
  try {
    await metadataStore.syncWithDisk();
    const apps = await metadataStore.getAllApps();
    const formatted = apps.map(app => ({
      ...app,
      fullUrl: `${PUBLIC_BASE_URL}${app.urlPath}`
    }));
    return res.json({ success: true, count: formatted.length, apps: formatted });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list apps', message: err.message });
  }
}

/**
 * DELETE /api/admin/apps
 */
export async function handleAdminDeleteApp(req, res) {
  try {
    const { scope, filename } = req.body || {};
    if (!scope || !filename) {
      return res.status(400).json({ error: 'Both scope and filename are required in the request body.' });
    }

    const result = await deleteAppFile(scope, filename);
    await metadataStore.removeApp(scope, filename);
    await metadataStore.syncWithDisk();

    return res.json({
      success: true,
      message: `App '${filename}' in scope '${scope}' deleted successfully.`
    });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({ error: 'Security Error', message: err.message });
    }
    return res.status(500).json({ error: 'Failed to delete app', message: err.message });
  }
}
