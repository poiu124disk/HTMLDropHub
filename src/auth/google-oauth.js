import crypto from 'node:crypto';
import { GOOGLE_AUTH, GOOGLE_AUTH_ENABLED } from '../config.js';
import { userStore } from '../services/user-store.js';
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createSessionToken,
  getCookie,
  safeCompare,
  setOAuthStateCookie,
  setSessionCookie
} from './session.js';

function sendError(res, status, message) {
  return res.status(status).type('text/plain').send(message);
}

function googleNotConfigured(res) {
  return sendError(
    res,
    503,
    'Google login is not configured.\n\n' +
    'Set auth.google.clientId and auth.google.clientSecret in data/config.json, ' +
    'then restart HTMLDropHub.'
  );
}

/**
 * GET /auth/google
 * Starts the Google OAuth authorization code flow.
 */
export function handleGoogleLogin(req, res) {
  if (!GOOGLE_AUTH_ENABLED) {
    return googleNotConfigured(res);
  }

  const state = crypto.randomBytes(32).toString('base64url');
  setOAuthStateCookie(req, res, state);

  const params = new URLSearchParams({
    client_id: GOOGLE_AUTH.clientId,
    redirect_uri: GOOGLE_AUTH.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });

  return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

/**
 * GET /auth/google/callback
 * Exchanges the authorization code, verifies the Google profile, and creates
 * a signed session cookie.
 */
export async function handleGoogleCallback(req, res) {
  if (!GOOGLE_AUTH_ENABLED) {
    return googleNotConfigured(res);
  }

  if (req.query.error) {
    return sendError(res, 400, `Google login was cancelled or failed: ${req.query.error}`);
  }

  const expectedState = getCookie(req, OAUTH_STATE_COOKIE);
  clearOAuthStateCookie(res);

  const receivedState = typeof req.query.state === 'string' ? req.query.state : '';
  if (!expectedState || !receivedState || !safeCompare(expectedState, receivedState)) {
    return sendError(res, 400, 'Invalid OAuth state. Please start the login flow again.');
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    return sendError(res, 400, 'Missing Google authorization code.');
  }

  let accessToken;
  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_AUTH.clientId,
        client_secret: GOOGLE_AUTH.clientSecret,
        redirect_uri: GOOGLE_AUTH.redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      const reason = tokenData.error_description || tokenData.error || 'Token exchange failed.';
      return sendError(res, 502, `Google token exchange failed: ${reason}`);
    }
    accessToken = tokenData.access_token;
  } catch (err) {
    return sendError(res, 502, `Could not reach Google token endpoint: ${err.message}`);
  }

  let profile;
  try {
    const userResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    profile = await userResponse.json();

    if (!userResponse.ok || !profile.sub) {
      const reason = profile.error_description || profile.error || 'User profile request failed.';
      return sendError(res, 502, `Could not load Google profile: ${reason}`);
    }
  } catch (err) {
    return sendError(res, 502, `Could not reach Google userinfo endpoint: ${err.message}`);
  }

  if (profile.email_verified !== true) {
    return sendError(res, 403, 'Your Google email address is not verified.');
  }

  const email = String(profile.email || '').toLowerCase();
  if (!email) {
    return sendError(res, 403, 'Google did not return an email address.');
  }

  if (GOOGLE_AUTH.allowedEmailDomains.length > 0) {
    const domain = email.split('@')[1] || '';
    if (!GOOGLE_AUTH.allowedEmailDomains.includes(domain)) {
      return sendError(res, 403, `Email domain "${domain}" is not allowed to sign in.`);
    }
  }

  try {
    const user = await userStore.upsertGoogleUser(profile);
    setSessionCookie(req, res, createSessionToken(user.id));
    return res.redirect('/dashboard');
  } catch (err) {
    console.error('[Google OAuth] Failed to create user session:', err);
    return sendError(res, 500, `Login failed: ${err.message}`);
  }
}

/**
 * POST /auth/logout
 */
export function handleLogout(req, res) {
  clearSessionCookie(res);
  return res.redirect('/');
}
