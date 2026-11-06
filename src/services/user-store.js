import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  USERS_FILE,
  MAX_API_KEYS_PER_USER,
  MAX_FILE_SIZE_MB,
  DEFAULT_ALLOW_OVERWRITE
} from '../config.js';
import { SecurityError } from '../auth/security.js';
import { generateApiToken } from './api-token.js';

const USERS_DIR = path.dirname(USERS_FILE);

function deriveUserIdentity(googleSub) {
  const hash = crypto.createHash('sha256').update(`google:${googleSub}`).digest('hex');
  return {
    id: hash.slice(0, 24),
    scope: `u_${hash.slice(24, 40)}`
  };
}

function clone(value) {
  return structuredClone(value);
}

/**
 * Persistent multi-user store backed by data/users.json.
 * Each user owns one jailed scope folder and a bounded list of API keys.
 */
class UserStore {
  constructor() {
    this.users = [];
    this.loaded = false;
    this.saveChain = Promise.resolve();
  }

  async init() {
    if (this.loaded) return;

    try {
      if (fsSync.existsSync(USERS_FILE)) {
        const raw = await fs.readFile(USERS_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.users = Array.isArray(data.users)
          ? data.users.map(user => ({
              ...user,
              apiKeys: Array.isArray(user.apiKeys) ? user.apiKeys : []
            }))
          : [];
      } else {
        this.users = [];
        await this._save();
      }
    } catch (err) {
      console.error('[UserStore] Failed to load users.json, starting with an empty list:', err.message);
      this.users = [];
    }

    this.loaded = true;
  }

  async _save() {
    // Serialize writes so concurrent logins/key creations cannot clobber each other.
    this.saveChain = this.saveChain.catch(() => {}).then(async () => {
      const data = JSON.stringify({ users: this.users }, null, 2);
      const tempFile = path.join(USERS_DIR, `.__tmp_users_${crypto.randomUUID()}`);
      await fs.writeFile(tempFile, data, 'utf8');
      try {
        await fs.rename(tempFile, USERS_FILE);
      } catch (err) {
        if (['EPERM', 'EEXIST', 'EBUSY'].includes(err.code)) {
          await fs.copyFile(tempFile, USERS_FILE);
          await fs.unlink(tempFile).catch(() => {});
        } else {
          await fs.unlink(tempFile).catch(() => {});
          throw err;
        }
      }
    });

    return this.saveChain;
  }

  /**
   * Creates or refreshes a user from a verified Google profile.
   */
  async upsertGoogleUser(profile) {
    await this.init();

    const googleSub = String(profile.sub || '').trim();
    const email = String(profile.email || '').trim().toLowerCase();

    if (!googleSub) throw new SecurityError('Google profile is missing the subject identifier.', 400);
    if (!email) throw new SecurityError('Google profile is missing an email address.', 400);

    const now = new Date().toISOString();
    let user = this.users.find(entry => entry.googleSub === googleSub);

    if (!user) {
      const identity = deriveUserIdentity(googleSub);
      user = {
        id: identity.id,
        googleSub,
        email,
        name: String(profile.name || email.split('@')[0]).trim(),
        picture: String(profile.picture || ''),
        scope: identity.scope,
        createdAt: now,
        lastLoginAt: now,
        apiKeys: []
      };
      this.users.push(user);
    } else {
      user.email = email;
      user.name = String(profile.name || user.name || email.split('@')[0]).trim();
      user.picture = String(profile.picture || user.picture || '');
      user.lastLoginAt = now;
    }

    await this._save();
    return clone(user);
  }

  async getUserById(id) {
    await this.init();
    const user = this.users.find(entry => entry.id === id);
    return user ? clone(user) : null;
  }

  async deleteUser(id) {
    await this.init();
    const before = this.users.length;
    this.users = this.users.filter(entry => entry.id !== id);
    if (this.users.length === before) return false;
    await this._save();
    return true;
  }

  /**
   * Creates a new API key for a user, enforcing the configured per-user limit.
   */
  async createApiKey(userId, options = {}) {
    await this.init();

    const user = this.users.find(entry => entry.id === userId);
    if (!user) throw new SecurityError('User not found.', 404);

    if (user.apiKeys.length >= MAX_API_KEYS_PER_USER) {
      throw new SecurityError(
        `API key limit reached. Each user may have at most ${MAX_API_KEYS_PER_USER} API key(s).`,
        403
      );
    }

    const requestedName = typeof options.name === 'string' ? options.name.trim() : '';
    const name = (requestedName || `API Key ${user.apiKeys.length + 1}`).slice(0, 80);
    const token = this._generateUniqueToken();

    const apiKey = {
      id: crypto.randomUUID(),
      name,
      token,
      scope: user.scope,
      enabled: true,
      allowOverwrite: DEFAULT_ALLOW_OVERWRITE,
      maxFileSizeMb: MAX_FILE_SIZE_MB,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    };

    user.apiKeys.push(apiKey);
    await this._save();
    return clone(apiKey);
  }

  async deleteApiKey(userId, keyId) {
    await this.init();

    const user = this.users.find(entry => entry.id === userId);
    if (!user) throw new SecurityError('User not found.', 404);

    const before = user.apiKeys.length;
    user.apiKeys = user.apiKeys.filter(key => key.id !== keyId);
    if (user.apiKeys.length === before) return false;

    await this._save();
    return true;
  }

  /**
   * Resolves an API key for the REST/MCP authentication middleware.
   */
  async getKeyByToken(token) {
    if (!token || typeof token !== 'string') return null;
    await this.init();
    const cleanToken = token.trim();

    for (const user of this.users) {
      const key = user.apiKeys.find(entry => entry.token === cleanToken);
      if (key) {
        return {
          ...clone(key),
          userId: user.id,
          userEmail: user.email,
          userName: user.name
        };
      }
    }

    return null;
  }

  async getAllKeys() {
    await this.init();
    const keys = [];
    for (const user of this.users) {
      for (const key of user.apiKeys) {
        keys.push({
          ...clone(key),
          userId: user.id,
          userEmail: user.email,
          userName: user.name
        });
      }
    }
    return keys;
  }

  async countAllKeys() {
    await this.init();
    return this.users.reduce((total, user) => total + user.apiKeys.length, 0);
  }

  _generateUniqueToken() {
    let token;
    do {
      token = generateApiToken();
    } while (this.users.some(user => user.apiKeys.some(key => key.token === token)));
    return token;
  }
}

export const userStore = new UserStore();
export { deriveUserIdentity };
