import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APPS_DIR, METADATA_FILE } from '../config.js';
import { extractHtmlMetadata } from '../auth/security.js';
import { keyStore } from './key-store.js';

class MetadataStore {
  constructor() {
    this.apps = {}; // key: "scope/filename"
    this.loaded = false;
  }

  async init() {
    if (this.loaded) return;
    try {
      if (fsSync.existsSync(METADATA_FILE)) {
        const raw = await fs.readFile(METADATA_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.apps = data.apps && typeof data.apps === 'object' ? data.apps : {};
      } else {
        this.apps = {};
        await this._save();
      }
    } catch (err) {
      console.error('[MetadataStore] Failed to load metadata.json, resetting:', err.message);
      this.apps = {};
    }
    this.loaded = true;
    await this.syncWithDisk();
  }

  async _save() {
    const data = JSON.stringify({ apps: this.apps }, null, 2);
    const tempFile = path.join(path.dirname(METADATA_FILE), `.__tmp_meta_${crypto.randomUUID()}`);
    await fs.writeFile(tempFile, data, 'utf8');
    try {
      await fs.rename(tempFile, METADATA_FILE);
    } catch (err) {
      if (['EPERM', 'EEXIST', 'EBUSY'].includes(err.code)) {
        await fs.copyFile(tempFile, METADATA_FILE);
        await fs.unlink(tempFile).catch(() => {});
      } else {
        await fs.unlink(tempFile).catch(() => {});
        throw err;
      }
    }
  }

  getAppKey(scope, filename) {
    return `${scope}/${filename}`;
  }

  async saveApp(scope, filename, meta = {}) {
    await this.init();
    const appKey = this.getAppKey(scope, filename);
    const now = new Date().toISOString();
    const existing = this.apps[appKey];

    this.apps[appKey] = {
      scope,
      filename,
      urlPath: `/${scope}/${filename}`,
      title: meta.title || existing?.title || filename,
      description: meta.description !== undefined ? meta.description : (existing?.description || ''),
      sizeBytes: meta.sizeBytes || existing?.sizeBytes || 0,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    await this._save();
    return this.apps[appKey];
  }

  async removeApp(scope, filename) {
    await this.init();
    const appKey = this.getAppKey(scope, filename);
    if (this.apps[appKey]) {
      delete this.apps[appKey];
      await this._save();
      return true;
    }
    return false;
  }

  async getAllApps() {
    await this.init();
    return Object.values(this.apps).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getAppsByScope(scope) {
    await this.init();
    return Object.values(this.apps)
      .filter(app => app.scope === scope)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async getApp(scope, filename) {
    await this.init();
    const appKey = this.getAppKey(scope, filename);
    return this.apps[appKey] || null;
  }

  /**
   * Scans the physical apps folder to sync metadata and purge deleted files
   */
  async syncWithDisk() {
    if (!fsSync.existsSync(APPS_DIR)) return;

    try {
      const scopeDirs = await fs.readdir(APPS_DIR, { withFileTypes: true });
      const currentKeysOnDisk = new Set();
      const countByScope = {};

      for (const scopeEntry of scopeDirs) {
        if (!scopeEntry.isDirectory() || scopeEntry.name.startsWith('.')) continue;
        const scope = scopeEntry.name;
        const scopePath = path.join(APPS_DIR, scope);
        countByScope[scope] = 0;

        const files = await fs.readdir(scopePath, { withFileTypes: true });
        for (const fileEntry of files) {
          if (!fileEntry.isFile() || fileEntry.name.startsWith('.')) continue;
          const filename = fileEntry.name;
          const lower = filename.toLowerCase();
          if (!lower.endsWith('.html') && !lower.endsWith('.htm')) continue;

          const appKey = this.getAppKey(scope, filename);
          currentKeysOnDisk.add(appKey);
          countByScope[scope]++;

          const fullFilePath = path.join(scopePath, filename);
          const stat = await fs.stat(fullFilePath);

          if (!this.apps[appKey]) {
            // New file detected directly on disk: extract title/metadata
            let title = filename;
            let description = '';
            try {
              const content = await fs.readFile(fullFilePath, 'utf8');
              const extracted = extractHtmlMetadata(content, filename);
              title = extracted.title;
              description = extracted.description;
            } catch {
              // fallback
            }

            this.apps[appKey] = {
              scope,
              filename,
              urlPath: `/${scope}/${filename}`,
              title,
              description,
              sizeBytes: stat.size,
              createdAt: stat.birthtime.toISOString(),
              updatedAt: stat.mtime.toISOString()
            };
          } else {
            // Update size if changed
            this.apps[appKey].sizeBytes = stat.size;
          }
        }
      }

      // Purge records for files that no longer exist on disk
      let cleaned = false;
      for (const appKey of Object.keys(this.apps)) {
        if (!currentKeysOnDisk.has(appKey)) {
          delete this.apps[appKey];
          cleaned = true;
        }
      }

      if (cleaned || Object.keys(this.apps).length > 0) {
        await this._save();
      }

      // Sync key store file counts
      await keyStore.syncFileCounts(countByScope);
    } catch (err) {
      console.error('[MetadataStore] Error syncing with disk:', err.message);
    }
  }
}

export const metadataStore = new MetadataStore();
