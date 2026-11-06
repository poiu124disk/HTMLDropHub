import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Built-in defaults. The real configuration lives in CONFIG_FILE (data/config.json
 * by default) and is created from these defaults on first launch.
 */
const DEFAULT_CONFIG = {
  server: {
    port: 3000,
    publicBaseUrl: 'http://localhost:3000',
    trustProxy: true,
    allowPublicCatalog: true
  },
  limits: {
    allowedExtensions: ['.html', '.htm'],
    maxFileSizeMb: 15,
    maxScopeSizeMb: 200,
    maxScopeFileCount: 100
  },
  defaults: {
    allowOverwrite: true
  },
  users: {
    maxApiKeysPerUser: 5
  },
  auth: {
    sessionSecret: '',
    google: {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      allowedEmailDomains: []
    }
  },
  apiKeys: []
};

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const CONFIG_FILE = path.resolve(process.env.CONFIG_FILE || path.join(DATA_DIR, 'config.json'));
export const APPS_DIR = path.join(DATA_DIR, 'apps');
export const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');
export const USERS_FILE = path.join(DATA_DIR, 'users.json');

function mergeConfig(base, override) {
  if (override === undefined) return base;
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return override;
  }

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = base?.[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === 'object' &&
      !Array.isArray(baseValue)
    ) {
      result[key] = mergeConfig(baseValue, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadLegacyKeys() {
  // Older versions stored API keys in data/keys.json. Import them once when
  // creating a configuration file so existing deployments keep working.
  const legacyKeysFile = path.join(DATA_DIR, 'keys.json');
  if (!fs.existsSync(legacyKeysFile)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(legacyKeysFile, 'utf8'));
    if (!Array.isArray(parsed.keys) || parsed.keys.length === 0) return null;

    return parsed.keys.map(key => ({
      name: key.name,
      token: key.token,
      scope: key.scope,
      enabled: key.enabled !== false,
      allowOverwrite: key.allowOverwrite !== false,
      ...(Number(key.maxFileSizeMb) > 0 ? { maxFileSizeMb: Number(key.maxFileSizeMb) } : {}),
      ...(key.notes ? { notes: key.notes } : {})
    }));
  } catch (err) {
    console.warn(`[Config] Could not migrate legacy keys.json: ${err.message}`);
    return null;
  }
}

function createDefaultConfigFile() {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });

  const initialConfig = structuredClone(DEFAULT_CONFIG);
  const legacyKeys = loadLegacyKeys();

  if (legacyKeys) {
    initialConfig.apiKeys = legacyKeys;
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8');
    console.log(`[Config] Created configuration file: ${CONFIG_FILE}`);
    console.log(`[Config] Migrated ${legacyKeys.length} API key(s) from legacy keys.json.`);
    return;
  }

  const token = `hdh_sec_${crypto.randomBytes(20).toString('hex')}`;
  initialConfig.apiKeys.push({
    name: 'Default_Developer',
    token,
    scope: 'demo',
    enabled: true,
    allowOverwrite: true
  });

  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(initialConfig, null, 2)}\n`, 'utf8');

  console.log(`[Config] Created default configuration file: ${CONFIG_FILE}`);
  console.log(`[Config] Generated API key for scope "demo": ${token}`);
}

function loadFileConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    createDefaultConfigFile();
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Root value must be a JSON object.');
    }
    return parsed;
  } catch (err) {
    throw new Error(`Invalid configuration file "${CONFIG_FILE}": ${err.message}`);
  }
}

const fileConfig = loadFileConfig();
export const config = mergeConfig(DEFAULT_CONFIG, fileConfig);

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeExtensions(value) {
  const source = Array.isArray(value) ? value : DEFAULT_CONFIG.limits.allowedExtensions;
  const extensions = source
    .map(ext => String(ext).trim().toLowerCase())
    .filter(Boolean)
    .map(ext => (ext.startsWith('.') ? ext : `.${ext}`));

  return [...new Set(extensions.length > 0 ? extensions : DEFAULT_CONFIG.limits.allowedExtensions)];
}

const server = config.server || DEFAULT_CONFIG.server;

export const PORT = Math.floor(positiveNumber(server.port, DEFAULT_CONFIG.server.port));
export const PUBLIC_BASE_URL = String(server.publicBaseUrl || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const TRUST_PROXY = server.trustProxy !== false;
export const ALLOW_PUBLIC_CATALOG = server.allowPublicCatalog !== false;

export const ALLOWED_EXTENSIONS = normalizeExtensions(config.limits?.allowedExtensions);
export const MAX_FILE_SIZE_MB = positiveNumber(config.limits?.maxFileSizeMb, DEFAULT_CONFIG.limits.maxFileSizeMb);
export const MAX_SCOPE_SIZE_MB = positiveNumber(config.limits?.maxScopeSizeMb, DEFAULT_CONFIG.limits.maxScopeSizeMb);
export const MAX_SCOPE_FILE_COUNT = Math.max(
  1,
  Math.floor(positiveNumber(config.limits?.maxScopeFileCount, DEFAULT_CONFIG.limits.maxScopeFileCount))
);

export const DEFAULT_ALLOW_OVERWRITE = config.defaults?.allowOverwrite !== false;
export const API_KEYS = Array.isArray(config.apiKeys) ? config.apiKeys : [];

export const MAX_API_KEYS_PER_USER = nonNegativeInteger(
  config.users?.maxApiKeysPerUser,
  DEFAULT_CONFIG.users.maxApiKeysPerUser
);
export const SESSION_SECRET = String(config.auth?.sessionSecret || '').trim();

const googleAuth = config.auth?.google || {};
export const GOOGLE_AUTH = {
  clientId: String(googleAuth.clientId || '').trim(),
  clientSecret: String(googleAuth.clientSecret || '').trim(),
  redirectUri: String(googleAuth.redirectUri || `${PUBLIC_BASE_URL}/auth/google/callback`).trim(),
  allowedEmailDomains: (Array.isArray(googleAuth.allowedEmailDomains) ? googleAuth.allowedEmailDomains : [])
    .map(domain => String(domain).trim().toLowerCase())
    .filter(Boolean)
};
export const GOOGLE_AUTH_ENABLED = Boolean(GOOGLE_AUTH.clientId && GOOGLE_AUTH.clientSecret);

// Ensure base directories exist
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(APPS_DIR, { recursive: true });
