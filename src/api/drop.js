import { PUBLIC_BASE_URL } from '../config.js';
import { saveAppFile } from '../services/storage.js';
import { keyStore } from '../services/key-store.js';
import { metadataStore } from '../services/metadata-store.js';
import { extractHtmlMetadata, SecurityError } from '../auth/security.js';

/**
 * Handles HTTP POST /api/drop
 * Supports JSON payload or raw text/html with x-filename header
 */
export async function handleDropApi(req, res) {
  try {
    const apiKey = req.apiKey;
    const scope = apiKey.scope;

    let filename = '';
    let content = '';
    let title = '';
    let description = '';

    if (req.is('application/json') || (typeof req.body === 'object' && !Buffer.isBuffer(req.body))) {
      filename = req.body.filename;
      content = req.body.content;
      title = req.body.title;
      description = req.body.description;
    } else {
      // Raw HTML body
      filename = req.headers['x-filename'] || req.query.filename;
      title = req.headers['x-title'] || req.query.title;
      description = req.headers['x-description'] || req.query.description;
      content = req.body;
    }

    if (!filename) {
      return res.status(400).json({
        error: 'Missing filename',
        message: 'A target filename (ending with .html or .htm) is required in the body or x-filename header.'
      });
    }

    if (!content) {
      return res.status(400).json({
        error: 'Missing content',
        message: 'HTML content is required.'
      });
    }

    const contentStr = typeof content === 'string' ? content : content.toString('utf8');

    // Auto extract metadata if omitted
    const extracted = extractHtmlMetadata(contentStr, filename);
    const appTitle = title?.trim() || extracted.title;
    const appDescription = description?.trim() !== undefined ? description.trim() : extracted.description;

    // Save app file with chroot & security validations
    const saved = await saveAppFile(scope, filename, contentStr, {
      allowOverwrite: apiKey.allowOverwrite,
      maxFileSizeMb: apiKey.maxFileSizeMb
    });

    // Save metadata
    await metadataStore.saveApp(scope, saved.filename, {
      title: appTitle,
      description: appDescription,
      sizeBytes: saved.sizeBytes
    });

    // Record key usage
    await keyStore.recordKeyUsage(apiKey.token, saved.isUpdate ? 0 : 1);

    const appUrl = `${PUBLIC_BASE_URL}/${scope}/${saved.filename}`;

    return res.status(201).json({
      success: true,
      message: saved.isUpdate ? 'Micro-app updated successfully' : 'Micro-app deployed successfully',
      data: {
        title: appTitle,
        description: appDescription,
        scope,
        filename: saved.filename,
        sizeBytes: saved.sizeBytes,
        url: appUrl,
        isUpdate: saved.isUpdate
      }
    });
  } catch (err) {
    if (err instanceof SecurityError) {
      return res.status(err.statusCode || 400).json({
        error: 'Security Error',
        message: err.message
      });
    }
    console.error('[Drop API Error]', err);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
}
