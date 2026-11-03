import { PUBLIC_BASE_URL } from '../config.js';
import { deleteAppFile } from '../services/storage.js';
import { keyStore } from '../services/key-store.js';
import { metadataStore } from '../services/metadata-store.js';
import { SecurityError } from '../auth/security.js';

/**
 * GET /api/apps
 * Lists apps for the authenticated scope or all public apps
 */
export async function handleListAppsApi(req, res) {
  try {
    const scope = req.apiKey?.scope || req.query.scope;
    const apps = scope ? await metadataStore.getAppsByScope(scope) : await metadataStore.getAllApps();

    const formatted = apps.map(app => ({
      ...app,
      fullUrl: `${PUBLIC_BASE_URL}${app.urlPath}`
    }));

    return res.json({
      success: true,
      count: formatted.length,
      apps: formatted
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list apps', message: err.message });
  }
}

/**
 * DELETE /api/apps/:filename
 * Deletes an app in the caller's scoped directory
 */
export async function handleDeleteAppApi(req, res) {
  try {
    const apiKey = req.apiKey;
    const filename = req.params.filename;

    if (!filename) {
      return res.status(400).json({ error: 'Missing filename parameter' });
    }

    const result = await deleteAppFile(apiKey.scope, filename);
    if (result.notFound) {
      return res.status(404).json({ error: 'App not found in your scoped directory' });
    }

    await metadataStore.removeApp(apiKey.scope, filename);
    await keyStore.recordKeyUsage(apiKey.token, -1);

    return res.json({
      success: true,
      message: `App '${filename}' deleted successfully from scope '${apiKey.scope}'`
    });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({ error: 'Security Error', message: err.message });
    }
    return res.status(500).json({ error: 'Failed to delete app', message: err.message });
  }
}
