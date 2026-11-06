import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PUBLIC_BASE_URL, SESSION_SECRET } from '../config.js';

export const SESSION_COOKIE = 'hdh_session';
export const OAUTH_STATE_COOKIE = 'hdh_oauth_state';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_FILE = path.join(DATA_DIR, 'session-secret');

let cachedSecret = null;

function loadSecret() {
  if (cachedSecret) return cachedSecret;

  if (SESSION_SECRET) {
    cachedSecret = SESSION_SECRET;
    return cachedSecret;
  }

  try {
    if (fs.existsSync(SECRET_FILE)) {
      const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      if (stored) {
        cachedSecret = stored;
        return cachedSecret;
      }
    }
  } catch {
    // Fall through to generating a new secret.
  }

  cachedSecret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRET_FILE, `${cachedSecret}\n`, { encoding: 'utf8', mode: 0o600 });
  console.warn(`[Session] Generated a persistent session secret at ${SECRET_FILE}`);
  return cachedSecret;
}

function sign(value) {
  return crypto.createHmac('sha256', loadSecret()).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

export function createSessionToken(userId) {
  const now = Date.now();
  const payload = {
    uid: userId,
    iat: now,
    exp: now + SESSION_TTL_MS
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return null;

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!safeEqual(signature, sign(body))) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      !payload ||
      typeof payload.uid !== 'string' ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function getCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }

  return null;
}

export function isSecureRequest(req) {
  return Boolean(req.secure) || PUBLIC_BASE_URL.startsWith('https://');
}

export function setSessionCookie(req, res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: SESSION_TTL_MS
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function setOAuthStateCookie(req, res, state) {
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: 10 * 60 * 1000
  });
}

export function clearOAuthStateCookie(res) {
  res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
}

export function safeCompare(a, b) {
  return safeEqual(a, b);
}
