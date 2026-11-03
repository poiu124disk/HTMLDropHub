import crypto from 'node:crypto';
import { ADMIN_PASSWORD } from '../config.js';
import { keyStore } from '../services/key-store.js';

/**
 * Computes a constant-time HMAC token for admin session cookies
 */
export function getAdminSessionSecret() {
  return crypto.createHash('sha256').update(`HTMLDropHub_Admin_${ADMIN_PASSWORD}`).digest('hex');
}

/**
 * Verifies admin password
 */
export function verifyAdminPassword(inputPassword) {
  if (typeof inputPassword !== 'string') return false;
  try {
    const a = Buffer.from(inputPassword);
    const b = Buffer.from(ADMIN_PASSWORD);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Middleware: Admin Authentication
 * Accepts Cloudflare Access header, admin session cookie, or Authorization Bearer (admin password)
 */
export function authenticateAdmin(req, res, next) {
  // 1. Cloudflare Access Header (if deployed behind Cloudflare Zero Trust)
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail && typeof cfEmail === 'string' && cfEmail.includes('@')) {
    req.adminUser = { type: 'cloudflare_access', email: cfEmail };
    return next();
  }

  // 2. Cookie session check
  const cookieToken = req.cookies?.hdh_admin_session;
  const expectedSecret = getAdminSessionSecret();
  if (cookieToken && cookieToken === expectedSecret) {
    req.adminUser = { type: 'cookie_session' };
    return next();
  }

  // 3. Bearer header or x-admin-password
  let authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (verifyAdminPassword(bearer) || bearer === expectedSecret) {
      req.adminUser = { type: 'bearer_token' };
      return next();
    }
  }

  const directPasswordHeader = req.headers['x-admin-password'];
  if (directPasswordHeader && verifyAdminPassword(directPasswordHeader)) {
    req.adminUser = { type: 'header_password' };
    return next();
  }

  // If request accepts HTML (like browser visiting /admin), redirect to login
  if (req.accepts('html') && !req.path.startsWith('/api/')) {
    return res.redirect(`/admin/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }

  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid admin credentials or active session required.'
  });
}

/**
 * Middleware: API Key Authentication
 * Authenticates Developer / AI client tokens
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
      message: 'This API Key has been disabled by the administrator.'
    });
  }

  // Attach key to request for downstream handlers
  req.apiKey = key;
  return next();
}
