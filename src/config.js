import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

export const PORT = parseInt(process.env.PORT || '3000', 10);
export const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const APPS_DIR = path.join(DATA_DIR, 'apps');
export const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
export const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');
export const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '15', 10);
export const ALLOW_PUBLIC_CATALOG = process.env.ALLOW_PUBLIC_CATALOG !== 'false';
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || true;

// Ensure base directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}
