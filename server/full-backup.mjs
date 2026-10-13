import { createHash } from 'node:crypto';
import { auditCutoff, retainedRecord } from './audit-retention.mjs';

const prefixes = ['recipes/', 'photos/', 'private/users/', 'private/usernames/', 'private/registrations/', 'private/password-changes/', 'private/password-heads/', 'private/deleted-users/', 'private/permissions/', 'private/permission-requests/', 'private/favorites/', 'private/password-recovery-requests/', 'private/password-recovery-decisions/', 'private/purged-recipes/', 'private/photo-optimizations/', 'private/photo-optimized/', 'private/audit/', 'private/audit-index/', 'private/audit-canonical/', 'private/audit-pending/'];
export const backupKey = key => typeof key === 'string' && key.length < 512 && /^[a-zA-Z0-9_./|:-]+$/.test(key) && !key.split('/').some(part => part === '..' || part === '.' || !part) && (prefixes.some(prefix => key.startsWith(prefix)) || key === 'private/photo-cache-version.json') && (key.startsWith('photos/') ? /^photos\/[a-f0-9]{64}\.(bin|txt)$/.test(key) : key.endsWith('.json'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const fail = (code, message) => { throw Object.assign(new Error(message), { status: 409, code }); };
export function snapshotTime(value) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(time) || time > Date.now() + 10000 || Date.now() - time > 3600000) fail('BACKUP_EXPIRED', '备份任务已过期，请重新生成。');
  return time;
}
export class FullBackup {
  constructor(store) { this.store = store; }
  async catalog(cursor = '') {
    if (cursor && !backupKey(cursor)) fail('INVALID_BACKUP_KEY', '备份分页位置不正确。');
    const { blobs } = await this.store.list({ prefix: '', consistency: 'strong' });
    const keys = [...new Set(blobs.map(item => item.key).filter(backupKey))].sort().filter(key => key > cursor);
    return { keys: keys.slice(0, 200), cursor: keys.length > 200 ? keys[199] : null };
  }
  async read(key, at) {
    if (!backupKey(key)) fail('INVALID_BACKUP_KEY', '此记录不允许导出。');
    const cutoff = auditCutoff(snapshotTime(at));
    if (key.endsWith('.bin')) {
      const value = await this.store.get(key, { type: 'arrayBuffer', consistency: 'strong' });
      if (value == null) fail('BACKUP_CHANGED', '备份期间数据发生变化，请暂停修改并重新生成。');
      return Buffer.from(value);
    }
    const value = await this.store.get(key, { type: key.endsWith('.json') ? 'json' : 'text', consistency: 'strong' });
    if (value == null) fail('BACKUP_CHANGED', '备份期间数据发生变化，请暂停修改并重新生成。');
    if (!key.endsWith('.json')) return Buffer.from(value);
    const next = retainedRecord(key, value, cutoff);
    return next === null ? null : Buffer.from(JSON.stringify(canonical(next)));
  }
  async chunk(key, at, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) fail('INVALID_BACKUP_OFFSET', '备份分块位置不正确。');
    const bytes = await this.read(key, at);
    if (bytes === null) return { key, skipped: true, sha256: null };
    if (offset > bytes.length) fail('INVALID_BACKUP_OFFSET', '备份分块位置不正确。');
    const end = Math.min(offset + 256 * 1024, bytes.length);
    return { key, offset, total: bytes.length, sha256: sha256(bytes), data: bytes.subarray(offset, end).toString('base64'), next: end < bytes.length ? end : null };
  }
  async verify(items, at) {
    if (!Array.isArray(items) || !items.length || items.length > 12) fail('INVALID_BACKUP_VERIFY', '备份校验请求不正确。');
    await Promise.all(items.map(async item => {
      const bytes = await this.read(item.key, at), digest = bytes === null ? null : sha256(bytes);
      if (digest !== item.sha256) fail('BACKUP_CHANGED', '备份期间数据发生变化，未生成文件。请暂停修改后重试。');
    }));
    return { ok: true };
  }
}
