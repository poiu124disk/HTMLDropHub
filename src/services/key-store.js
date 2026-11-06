import crypto from 'node:crypto';
import {
  API_KEYS,
  DEFAULT_ALLOW_OVERWRITE,
  MAX_FILE_SIZE_MB
} from '../config.js';
import { validateScope, SecurityError } from '../auth/security.js';
import { generateApiToken } from './api-token.js';
import { userStore } from './user-store.js';

/**
 * Read-only API key store backed by config.json.
 *
 * Keys are defined in the `apiKeys` array of the configuration file. Runtime
 * keys added through createKey() live in memory only and are intended for
 * tests or embedded usage; they are never written back to disk.
 */
class KeyStore {
  constructor() {
    this.keys = [];
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;

    const seenTokens = new Set();
    this.keys = API_KEYS.map((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`apiKeys[${index}] must be a JSON object.`);
      }

      const token = typeof entry.token === 'string' ? entry.token.trim() : '';
      if (!token) {
        throw new Error(`apiKeys[${index}].token is required.`);
      }
      if (seenTokens.has(token)) {
        throw new Error(`apiKeys[${index}].token is duplicated.`);
      }
      seenTokens.add(token);

      let scope;
      try {
        scope = validateScope(entry.scope);
      } catch (err) {
        throw new Error(`apiKeys[${index}].scope is invalid: ${err.message}`);
      }

      const maxFileSizeMb = Number(entry.maxFileSizeMb);

      return {
        id: entry.id || `cfg_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)}`,
        name: String(entry.name || `Key_${index + 1}`).trim(),
        token,
        scope,
        enabled: entry.enabled !== false,
        allowOverwrite: entry.allowOverwrite !== undefined
          ? Boolean(entry.allowOverwrite)
          : DEFAULT_ALLOW_OVERWRITE,
        maxFileSizeMb: Number.isFinite(maxFileSizeMb) && maxFileSizeMb > 0
          ? Math.min(maxFileSizeMb, MAX_FILE_SIZE_MB)
          : MAX_FILE_SIZE_MB,
        notes: typeof entry.notes === 'string' ? entry.notes.trim() : ''
      };
    });

    this.loaded = true;

    if (this.keys.length === 0) {
      console.warn('[KeyStore] No API keys configured. Add entries to "apiKeys" in the configuration file.');
    }
  }

  async getAllKeys() {
    await this.init();
    const configKeys = this.keys.map(key => ({ ...key }));
    const userKeys = await userStore.getAllKeys();
    return [...configKeys, ...userKeys];
  }

  async getKeyByToken(token) {
    if (!token || typeof token !== 'string') return null;
    await this.init();
    const cleanToken = token.trim();
    const found = this.keys.find(key => key.token === cleanToken);
    if (found) return { ...found };

    // Fall back to keys created by Google-authenticated users.
    return userStore.getKeyByToken(cleanToken);
  }

  async getKeyById(id) {
    await this.init();
    const found = this.keys.find(key => key.id === id);
    return found ? { ...found } : null;
  }

  generateToken() {
    return generateApiToken();
  }

  /**
   * Registers an in-memory key. Configuration keys should be added to the
   * `apiKeys` array in config.json instead.
   */
  async createKey(options = {}) {
    await this.init();

    const {
      name,
      scope,
      token = this.generateToken(),
      allowOverwrite = DEFAULT_ALLOW_OVERWRITE,
      maxFileSizeMb = MAX_FILE_SIZE_MB,
      enabled = true,
      notes = ''
    } = options;

    if (!name || typeof name !== 'string') {
      throw new SecurityError('Key name is required.', 400);
    }

    const safeScope = validateScope(scope);
    const cleanToken = String(token).trim();

    if (!cleanToken) {
      throw new SecurityError('Token is required.', 400);
    }
    if (this.keys.some(key => key.token === cleanToken)) {
      throw new SecurityError('Token already exists. Choose a different token.', 400);
    }

    const numericMaxSize = Number(maxFileSizeMb);
    const newKey = {
      id: crypto.randomUUID(),
      name: name.trim(),
      token: cleanToken,
      scope: safeScope,
      enabled: Boolean(enabled),
      allowOverwrite: Boolean(allowOverwrite),
      maxFileSizeMb: Number.isFinite(numericMaxSize) && numericMaxSize > 0
        ? Math.min(numericMaxSize, MAX_FILE_SIZE_MB)
        : MAX_FILE_SIZE_MB,
      notes: typeof notes === 'string' ? notes.trim() : ''
    };

    this.keys.push(newKey);
    return { ...newKey };
  }
}

export const keyStore = new KeyStore();
