import { openBackupPart, digest, unbase64 } from '../dist/full-backup.js';
import { backupKey, canonical, sha256 } from './full-backup.mjs';
import { retainedRecord, auditCutoff } from './audit-retention.mjs';
import { Accounts } from './accounts.mjs';
import { DEFAULT_ACCOUNT } from './auth-config.mjs';
const markerKey = 'private/full-restore.json';
const utf8 = new TextEncoder();
export async function readFullBackup(texts, password) {
  const parts = [];
  for (const text of texts) parts.push(await openBackupPart(text, password));
  parts.sort((a, b) => a.part - b.part);
  const manifest = parts[0]?.manifest;
  if (!manifest || parts.length !== parts[0].parts || parts.some((part, i) => part.part !== i + 1 || part.parts !== parts.length || JSON.stringify(part.manifest) !== JSON.stringify(manifest))) throw new Error('缺少分卷、重复分卷或混入不同批次，未写入任何数据');
  if (manifest.retentionDays !== 7 || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('备份清单不正确');
  const records = parts.flatMap(part => part.records), descriptors = [], values = new Map();
  for (const entry of records) {
    if (!backupKey(entry.key) || values.has(entry.key) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > 24 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('备份记录路径、大小或编号不正确');
    const bytes = unbase64(entry.data);
    if (bytes.length !== entry.bytes || await digest(bytes) !== entry.sha256) throw new Error('备份内容校验失败，未写入任何数据');
    descriptors.push({ key: entry.key, sha256: entry.sha256, bytes: entry.bytes });
    if (entry.key.endsWith('.json')) JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    values.set(entry.key, bytes);
  }
  if (records.length !== manifest.recordCount || await digest(utf8.encode(JSON.stringify(descriptors))) !== manifest.recordDigest) throw new Error('备份清单与数据不匹配');
  // Verify every historical photo reference, following optimization aliases.
  const json = key => values.has(key) ? JSON.parse(Buffer.from(values.get(key)).toString()) : null;
  for (const [key] of values) {
    if (!key.startsWith('recipes/')) continue;
    const event = json(key);
    if (event.revision !== key || typeof event.id !== 'string' || !Object.hasOwn(event, 'deleted')) throw new Error('菜谱历史记录不完整');
    let photo = event.photoHash; const seen = new Set();
    while (photo) {
      if (!/^[a-f0-9]{64}$/.test(photo) || seen.has(photo) || seen.size >= 10) throw new Error('历史照片引用损坏');
      seen.add(photo); const alias = json(`private/photo-optimizations/${photo}.json`);
      if (alias && alias.targetHash !== photo) { photo = alias.targetHash; continue; }
      if (!values.has(`photos/${photo}.bin`) && !values.has(`photos/${photo}.txt`)) throw new Error('缺少历史照片，未写入任何数据');
      break;
    }
  }
  const readStore = {
    async get(key) { return json(key); },
    async list({ prefix = '' } = {}) { return { blobs: [...values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
  };
  const accounts = new Accounts(readStore, DEFAULT_ACCOUNT);
  if (!values.has(accounts.key(accounts.legacyId))) throw new Error('备份缺少管理员账号');
  for (const [key] of values) if (key.startsWith('private/users/')) {
    const value = json(key);
    if (accounts.key(value.id) !== key || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{64}$/.test(value.passwordHash)) throw new Error('账号密码校验数据不完整');
    await accounts.get(value.id);
  }
  return { manifest, values };
}
export async function restoreFullBackup(store, archive, { onProgress = () => {} } = {}) {
  const { manifest, values } = archive, cutoff = auditCutoff(), prepared = new Map();
  // A backup cannot reintroduce expired logs when restored weeks later.
  for (const [key, bytes] of values) {
    if (!key.endsWith('.json')) { prepared.set(key, bytes); continue; }
    const value = retainedRecord(key, JSON.parse(Buffer.from(bytes).toString()), cutoff);
    if (value !== null) prepared.set(key, Buffer.from(JSON.stringify(canonical(value))));
  }
  const marker = await store.get(markerKey, { type: 'json', consistency: 'strong' });
  const resume = marker?.backupId === manifest.backupId && marker?.recordDigest === manifest.recordDigest;
  if (marker && !resume) throw new Error('目标已有另一份迁移任务，请使用新的空存储空间');
  const existing = (await store.list({ prefix: '', consistency: 'strong' })).blobs.map(item => item.key).filter(key => !['private/account-database-binding.json', markerKey].includes(key));
  if (existing.length && !resume) throw new Error('目标不是空站点，拒绝覆盖现有账号和菜谱');
  const read = async key => key.endsWith('.json') ? Buffer.from(JSON.stringify(canonical(await store.get(key, { type: 'json', consistency: 'strong' })))) : Buffer.from(await store.get(key, { type: 'arrayBuffer', consistency: 'strong' }));
  for (const key of existing) {
    if (!values.has(key)) throw new Error('目标包含其他数据，拒绝继续迁移');
    const bytes = await read(key);
    const original = values.get(key), next = prepared.get(key);
    if (sha256(bytes) !== sha256(original) && (!next || sha256(bytes) !== sha256(next))) throw new Error('目标数据已被修改，拒绝覆盖');
  }
  await store.setJSON(markerKey, { backupId: manifest.backupId, recordDigest: manifest.recordDigest, complete: false }, { cacheControl: 'no-store' });
  let completed = 0;
  for (const [key, bytes] of prepared) {
    if (key.endsWith('.json')) await store.setJSON(key, JSON.parse(Buffer.from(bytes).toString()), { cacheControl: 'no-store' });
    else await store.set(key, Uint8Array.from(bytes).buffer, { cacheControl: 'no-store' });
    if (sha256(await read(key)) !== sha256(bytes)) throw new Error('恢复后读取校验失败，可使用同一备份重试');
    onProgress(++completed, prepared.size);
  }
  for (const key of existing) if (!prepared.has(key)) await store.delete(key);
  // Force the destination to rebuild only recent audit indexes. Deployment
  // credentials, SQL binding and session signing keys always belong to target.
  await store.setJSON(markerKey, { backupId: manifest.backupId, recordDigest: manifest.recordDigest, complete: true, restoredAt: new Date().toISOString(), records: prepared.size }, { cacheControl: 'no-store' });
  return { records: prepared.size, summary: manifest.summary };
}
