const utf8 = new TextEncoder(), decoder = new TextDecoder();
export const FULL_BACKUP_FORMAT = 'fengwei-full-backup';
export const FULL_BACKUP_MAX_BYTES = 50 * 1024 * 1024;
const ITERATIONS = 250000;
export function base64(bytes) { let result = ''; for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768)); return btoa(result); }
export function unbase64(value) {
  if (typeof value !== 'string' || value.length % 4 || (/[^A-Za-z0-9+/=]/.test(value) || (value.includes('=') && !/^[^=]*={1,2}$/.test(value)))) throw new Error('备份编码损坏');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}
export const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
async function derive(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('备份口令需要 12～256 个字符');
  const material = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function transform(bytes, compression, limit = 34 * 1024 * 1024) {
  const stream = new Blob([bytes]).stream().pipeThrough(compression ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  const reader = stream.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) throw new Error('备份解压后超过单份限制'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
const aad = header => utf8.encode(JSON.stringify([header.format, header.version, header.backupId, header.part, header.parts, header.salt, header.iv]));
export async function sealBackup(records, metadata, password, { partBytes = 32 * 1024 * 1024 } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), key = await derive(password, salt);
  const descriptors = records.map(({ key, sha256, bytes }) => ({ key, sha256, bytes }));
  const manifest = { ...metadata, recordCount: records.length, recordDigest: await digest(utf8.encode(JSON.stringify(descriptors))) };
  const overhead = utf8.encode(JSON.stringify(manifest)).length + 128;
  if (!Number.isSafeInteger(partBytes) || partBytes < overhead || partBytes > 32 * 1024 * 1024) throw new Error('分卷大小无效');
  const groups = []; let group = [], size = overhead;
  for (const record of records) {
    const bytes = utf8.encode(JSON.stringify(record)).length + 1;
    if (bytes > partBytes - overhead) throw new Error('单条记录过大，无法生成完整备份');
    if (group.length && size + bytes > partBytes) { groups.push(group); group = []; size = overhead; }
    group.push(record); size += bytes;
  }
  if (group.length || !groups.length) groups.push(group);
  const files = [];
  for (let i = 0; i < groups.length; i++) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = { format: FULL_BACKUP_FORMAT, version: 1, backupId: metadata.backupId, part: i + 1, parts: groups.length, salt: base64(salt), iv: base64(iv) };
    const packed = await transform(utf8.encode(JSON.stringify({ manifest, records: groups[i] })), true);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(header) }, key, packed);
    const text = JSON.stringify({ ...header, kdf: 'PBKDF2-SHA256-250000', cipher: 'AES-256-GCM', compression: 'gzip', data: base64(new Uint8Array(encrypted)) });
    const file = new File([text], `峰味完整备份-${metadata.createdAt.replace(/[.:]/g, '-')}-${metadata.backupId.slice(0, 8)}-${i + 1}of${groups.length}.fengwei`, { type: 'application/octet-stream' });
    if (file.size > FULL_BACKUP_MAX_BYTES) throw new Error('备份超过单份 50 MiB 限制');
    files.push({ file, count: groups[i].length, downloaded: false });
  }
  return { files, manifest };
}
export async function openBackupPart(text, password) {
  if (typeof text !== 'string' || new Blob([text]).size > FULL_BACKUP_MAX_BYTES) throw new Error('完整备份单份最多 50 MiB');
  let data; try { data = JSON.parse(text); } catch { throw new Error('完整备份格式不正确'); }
  if (data.format !== FULL_BACKUP_FORMAT || data.version !== 1 || data.kdf !== 'PBKDF2-SHA256-250000' || data.cipher !== 'AES-256-GCM' || data.compression !== 'gzip' || !/^[a-f0-9-]{36}$/.test(data.backupId) || !Number.isSafeInteger(data.parts) || data.parts < 1 || data.parts > 100000 || !Number.isSafeInteger(data.part) || data.part < 1 || data.part > data.parts) throw new Error('完整备份格式或版本不受支持');
  const salt = unbase64(data.salt), iv = unbase64(data.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('备份加密参数损坏');
  const key = await derive(password, salt); let plain;
  try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(data) }, key, unbase64(data.data)); }
  catch { throw new Error('备份口令不正确，或文件已损坏'); }
  const result = JSON.parse(decoder.decode(await transform(new Uint8Array(plain), false)));
  if (!Array.isArray(result.records) || result.manifest?.backupId !== data.backupId) throw new Error('备份内容校验失败');
  return { ...result, part: data.part, parts: data.parts };
}
export async function prepareFullBackup(store, password, progress = () => {}) {
  const expected = store.user?.id, start = await store.fullBackupRequest('start', {});
  const check = () => { if (!expected || store.user?.id !== expected) throw new Error('账号已切换，完整备份已取消'); };
  const request = async (action, value) => { check(); const data = await store.fullBackupRequest(action, { ...value, snapshotAt: start.snapshotAt }); check(); return data; };
  async function catalog() { const all = []; let cursor = ''; do { const page = await request('catalog', { cursor }); all.push(...page.keys); if (page.cursor && page.cursor <= cursor) throw new Error('备份分页异常'); cursor = page.cursor; } while (cursor); return all; }
  const keys = await catalog(), records = [], checks = [];
  const summary = { accounts: 0, versions: 0, photos: 0, permissions: 0, logs: 0 };
  for (const name of keys) {
    progress(`正在读取 ${checks.length + 1} / ${keys.length} 条记录`);
    let offset = 0, sha = '', total = 0; const chunks = []; let skipped = false;
    do {
      const part = await request('read', { key: name, offset });
      if (part.skipped) { skipped = true; break; }
      if (part.offset !== offset || part.total > 24 * 1024 * 1024 || (sha && sha !== part.sha256)) throw new Error('备份期间记录变化或体积过大，请重试');
      sha = part.sha256; total = part.total; chunks.push(unbase64(part.data));
      if (part.next !== null && part.next <= offset) throw new Error('备份分块异常'); offset = part.next;
    } while (offset !== null);
    checks.push({ key: name, sha256: skipped ? null : sha });
    if (skipped) continue;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    if (bytes.length !== total || await digest(bytes) !== sha) throw new Error('备份记录校验失败，请重试');
    records.push({ key: name, sha256: sha, bytes: bytes.length, data: base64(bytes) });
    if (name.startsWith('private/users/')) summary.accounts++;
    if (name.startsWith('recipes/')) summary.versions++;
    if (name.startsWith('photos/')) summary.photos++;
    if (name.startsWith('private/permissions/')) summary.permissions++;
    if (name.startsWith('private/audit-canonical/')) summary.logs++;
  }
  progress('正在复核全部记录，确认备份期间数据未变化');
  if (JSON.stringify(keys) !== JSON.stringify(await catalog())) throw new Error('备份期间有新增或删除，请暂停其他设备操作后重试');
  for (let i = 0; i < checks.length; i += 12) await request('verify', { items: checks.slice(i, i + 12) });
  if (JSON.stringify(keys) !== JSON.stringify(await catalog())) throw new Error('备份期间有新增或删除，请重新生成');
  progress('正在压缩并加密完整备份');
  const result = await sealBackup(records, { backupId: crypto.randomUUID(), createdAt: start.snapshotAt, retentionDays: 7, summary }, password);
  check(); return { ...result, userId: expected };
}
export function fullBackupPanel({ user, busy, progress, error, prepared, esc }) {
  if (user?.role !== 'admin') return '';
  return `<section class="panel full-backup-panel"><h2>完整迁移备份 · 管理员</h2><p>包含全部账号及密码校验数据、权限与申请、所有人的收藏、菜谱全部历史和照片、最近 7 天操作日志。迁移后可继续使用原账号密码登录。</p><p class="small-note">文件使用独立口令加密，请妥善保存口令。仅在本设备内存中加密，口令不会上传。正式迁移前请暂停其他设备操作。</p><form id="full-backup-form"><div class="full-backup-passwords"><label class="field"><span class="field-label">备份口令</span><input name="backupPassword" type="password" autocomplete="off" required minlength="12" maxlength="256" ${busy ? 'disabled' : ''} placeholder="至少 12 个字符，与登录密码分开"></label><label class="field"><span class="field-label">确认备份口令</span><input name="backupConfirm" type="password" autocomplete="off" required minlength="12" maxlength="256" ${busy ? 'disabled' : ''}></label></div><button class="button primary" type="submit" ${busy ? 'disabled' : ''}>${busy ? '正在生成完整备份…' : '生成加密完整备份'}</button></form>${progress ? `<p role="status">${esc(progress)}</p>` : ''}${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}${prepared ? `<div class="backup-ready"><p>已生成 ${prepared.files.length} 份完整备份 · ${prepared.manifest.summary.accounts} 个账号 · ${prepared.manifest.summary.versions} 个菜谱历史记录 · ${prepared.manifest.summary.photos} 个图片对象。请保存全部分卷。</p><ul class="backup-files">${prepared.files.map(({ file, downloaded }, index) => `<li><strong>第 ${index + 1} / ${prepared.files.length} 份 · ${(file.size / 1048576).toFixed(2)} MiB</strong><small>${esc(file.name)}</small><button class="button ghost" data-action="download-full-backup" data-index="${index}">${downloaded ? '再次下载' : '下载'}第 ${index + 1} 份</button>${downloaded ? '<small>已发起保存，请确认文件已保存。</small>' : ''}</li>`).join('')}</ul></div>` : ''}<p class="small-note">完整备份用于新站点迁移，使用仓库 scripts/restore-full-backup.mjs 校验和恢复。普通菜谱导入仅处理菜谱 JSON。站点密钥和登录会话不随备份迁移。</p></section>`;
}
