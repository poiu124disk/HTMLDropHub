import { keyStore } from '../services/key-store.js';

/**
 * Middleware: API Key Authentication
 * Authenticates Developer / AI client tokens against config.json.
 */
export async function authenticateApiKey(req, res, next) {
  let token = null;

  // 1. Authorization: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  // 2. x-api-key header
  if (!token && req.headers['x-api-key']) {
    token = String(req.headers['x-api-key']).trim();
  }

  // 3. Query parameter ?token=
  if (!token && req.query.token) {
    token = String(req.query.token).trim();
  }

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'API Key token is required. Provide via Authorization header (Bearer <token>) or ?token= query parameter.'
    });
  }

  const key = await keyStore.getKeyByToken(token);
  if (!key) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or revoked API Key token.'
    });
  }

  if (!key.enabled) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This API Key is disabled in the configuration file.'
    });
  }

  // Attach key to request for downstream handlers
  req.apiKey = key;
  return next();
}
