import crypto from 'node:crypto';

export function generateApiToken() {
  return `hdh_sec_${crypto.randomBytes(20).toString('hex')}`;
}
