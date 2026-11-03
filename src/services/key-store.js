import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { KEYS_FILE, MAX_FILE_SIZE_MB } from '../config.js';
import { validateScope, SecurityError } from '../auth/security.js';

class KeyStore {
  constructor() {
    this.keys = [];
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    try {
      if (fsSync.existsSync(KEYS_FILE)) {
        const raw = await fs.readFile(KEYS_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.keys = Array.isArray(data.keys) ? data.keys : [];
      } else {
        this.keys = [];
        await this._save();
      }
    } catch (err) {
      console.error('[KeyStore] Failed to load keys.json, initializing empty:', err.message);
      this.keys = [];
    }
    this.loaded = true;
  }

  async _save() {
    const data = JSON.stringify({ keys: this.keys }, null, 2);
    const tempFile = path.join(path.dirname(KEYS_FILE), `.__tmp_keys_${crypto.randomUUID()}`);
    await fs.writeFile(tempFile, data, 'utf8');
    await fs.rename(tempFile, KEYS_FILE);
  }

  async getAllKeys() {
    await this.init();
    return [...this.keys];
  }

  async getKeyByToken(token) {
    if (!token || typeof token !== 'string') return null;
    await this.init();
    const cleanToken = token.trim();
    const found = this.keys.find(k => k.token === cleanToken);
    if (!found) return null;
    return { ...found };
  }

  async getKeyById(id) {
    await this.init();
    const found = this.keys.find(k => k.id === id);
    return found ? { ...found } : null;
  }

  generateToken() {
    const randomHex = crypto.randomBytes(20).toString('hex');
    return `hdh_sec_${randomHex}`;
  }

  async createKey(options) {
    await this.init();
    const {
      name,
      scope,
      token = this.generateToken(),
      allowOverwrite = true,
      maxFileSizeMb = MAX_FILE_SIZE_MB,
      enabled = true,
      notes = ''
    } = options;

    if (!name || typeof name !== 'string') {
      throw new SecurityError('Key name is required.', 400);
    }

    const safeScope = validateScope(scope);

    // Check if token already exists
    if (this.keys.some(k => k.token === token)) {
      throw new SecurityError('Token already exists. Please regenerate or choose a different token.', 400);
    }

    const newKey = {
      id: crypto.randomUUID(),
      name: name.trim(),
      token: token.trim(),
      scope: safeScope,
      enabled: Boolean(enabled),
      allowOverwrite: Boolean(allowOverwrite),
      maxFileSizeMb: Number(maxFileSizeMb) || MAX_FILE_SIZE_MB,
      notes: typeof notes === 'string' ? notes.trim() : '',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      fileCount: 0
    };

    this.keys.push(newKey);
    await this._save();
    return newKey;
  }

  async updateKey(id, updates) {
    await this.init();
    const idx = this.keys.findIndex(k => k.id === id);
    if (idx === -1) {
      throw new SecurityError('Key not found.', 404);
    }

    const current = this.keys[idx];
    const updated = { ...current };

    if (updates.name !== undefined) updated.name = updates.name.trim();
    if (updates.scope !== undefined) updated.scope = validateScope(updates.scope);
    if (updates.enabled !== undefined) updated.enabled = Boolean(updates.enabled);
    if (updates.allowOverwrite !== undefined) updated.allowOverwrite = Boolean(updates.allowOverwrite);
    if (updates.maxFileSizeMb !== undefined) updated.maxFileSizeMb = Number(updates.maxFileSizeMb) || MAX_FILE_SIZE_MB;
    if (updates.notes !== undefined) updated.notes = updates.notes;

    this.keys[idx] = updated;
    await this._save();
    return updated;
  }

  async deleteKey(id) {
    await this.init();
    const initialLen = this.keys.length;
    this.keys = this.keys.filter(k => k.id !== id);
    if (this.keys.length !== initialLen) {
      await this._save();
      return true;
    }
    return false;
  }

  async recordKeyUsage(token, fileCountDelta = 0) {
    await this.init();
    const key = this.keys.find(k => k.token === token);
    if (key) {
      key.lastUsedAt = new Date().toISOString();
      if (fileCountDelta !== 0) {
        key.fileCount = Math.max(0, (key.fileCount || 0) + fileCountDelta);
      }
      await this._save();
    }
  }

  async syncFileCounts(countByScopeMap) {
    await this.init();
    let changed = false;
    for (const key of this.keys) {
      const count = countByScopeMap[key.scope] || 0;
      if (key.fileCount !== count) {
        key.fileCount = count;
        changed = true;
      }
    }
    if (changed) {
      await this._save();
    }
  }
}

export const keyStore = new KeyStore();
