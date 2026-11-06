import { userStore } from '../services/user-store.js';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  getCookie,
  verifySessionToken
} from './session.js';

async function resolveSessionUser(req) {
  const token = getCookie(req, SESSION_COOKIE);
  const payload = verifySessionToken(token);
  if (!payload) return null;
  return userStore.getUserById(payload.uid);
}

/**
 * Attaches req.user when a valid session exists, but never blocks the request.
 */
export async function optionalUser(req, res, next) {
  try {
    req.user = await resolveSessionUser(req);
  } catch (err) {
    console.error('[Auth] Failed to resolve session:', err.message);
    req.user = null;
  }
  next();
}

/**
 * Requires a Google-authenticated user. API requests receive 401 JSON;
 * browser requests are redirected to the Google login flow.
 */
export async function authenticateUser(req, res, next) {
  let user = null;

  try {
    user = await resolveSessionUser(req);
  } catch (err) {
    console.error('[Auth] Failed to resolve session:', err.message);
  }

  if (user) {
    req.user = user;
    return next();
  }

  clearSessionCookie(res);

  const wantsJson = req.path.startsWith('/api/') || !req.accepts('html');
  if (wantsJson) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Google login is required.'
    });
  }

  return res.redirect('/auth/google');
}
