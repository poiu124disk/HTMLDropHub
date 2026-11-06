import {
  PUBLIC_BASE_URL,
  MAX_API_KEYS_PER_USER
} from '../config.js';
import { userStore } from '../services/user-store.js';
import { SecurityError } from '../auth/security.js';

function keyClientConfig(key) {
  const sseUrl = `${PUBLIC_BASE_URL}/sse?token=${key.token}`;
  const serverName = `htmldrophub-${key.scope}`;

  return {
    sseUrl,
    cursorJson: JSON.stringify({
      mcpServers: {
        [serverName]: { url: sseUrl }
      }
    }, null, 2),
    claudeDesktopJson: JSON.stringify({
      mcpServers: {
        [serverName]: { url: sseUrl }
      }
    }, null, 2),
    curlExample: `curl -X POST "${PUBLIC_BASE_URL}/api/drop" \\
  -H "Authorization: Bearer ${key.token}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "filename": "hello.html",
    "title": "My First Micro-App",
    "description": "Created via API",
    "content": "<!DOCTYPE html><html><body><h1>Hello from HTMLDropHub!</h1></body></html>"
  }'`
  };
}

function decorateKey(key) {
  return {
    ...key,
    configs: keyClientConfig(key)
  };
}

/**
 * GET /api/me
 */
export async function handleGetMe(req, res) {
  const user = req.user;
  const keys = user.apiKeys.map(decorateKey);

  return res.json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      scope: user.scope,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt
    },
    publicBaseUrl: PUBLIC_BASE_URL,
    maxApiKeysPerUser: MAX_API_KEYS_PER_USER,
    keyCount: keys.length,
    keys
  });
}

/**
 * POST /api/me/keys
 */
export async function handleCreateMyKey(req, res) {
  try {
    const name = req.body?.name;
    const key = await userStore.createApiKey(req.user.id, { name });

    return res.status(201).json({
      success: true,
      message: 'API key created successfully.',
      key: decorateKey(key)
    });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({
        error: 'API Key Error',
        message: err.message
      });
    }
    console.error('[Me API] Failed to create API key:', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
}

/**
 * DELETE /api/me/keys/:id
 */
export async function handleDeleteMyKey(req, res) {
  try {
    const deleted = await userStore.deleteApiKey(req.user.id, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'API key not found.' });
    }
    return res.json({ success: true, message: 'API key deleted.' });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({
        error: 'API Key Error',
        message: err.message
      });
    }
    console.error('[Me API] Failed to delete API key:', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
}
