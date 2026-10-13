import { createHash, randomUUID } from 'node:crypto';
import { Photos } from './photos.mjs';
import { joinPhoto } from '../dist/photo-wire.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class ConflictError extends Error {
  constructor(message = '这道菜已在另一台设备更新，请同步后再编辑。当前修改尚未保存。') { super(message); this.status = 409; this.code = 'CONFLICT'; }
}
const eventPattern = /^recipes\/([a-f0-9]{64})\/(\d{12})-\d{13}-[a-zA-Z0-9-]{8,200}\.json$/;
const versionKey = (id, generation, mutationId) => `recipes/${hash(id)}/${String(generation).padStart(12, '0')}-${Date.now()}-${randomUUID()}-${mutationId}.json`;
const purgeKey = id => `private/purged-recipes/${hash(id)}.json`;
const purgedError = () => Object.assign(new Error('这道菜已被彻底删除，不能恢复或继续保存。可将本机内容另存为新菜。'), { status: 410, code: 'RECIPE_PURGED' });
const generationOf = revision => Number(revision?.match(/\/(\d{12})-/)?.[1] || 0);

// Independent immutable versions: Blob's onlyIfNew is explicitly unsupported
// in SDK 0.0.18, so it MUST NOT be used as a lock/CAS. A stale editor is rejected
// on read; truly concurrent writes can form siblings, all of which are retained
// and exposed via the history UI. Generation + timestamp + ID picks the head.
export class RecipeDatabase {
  constructor(store) { this.store = store; this.photos = new Photos(store); }
  async headKeys(prefix = 'recipes/') {
    const [{ blobs }, purged] = await Promise.all([this.store.list({ prefix, consistency: 'strong' }), this.store.list({ prefix: 'private/purged-recipes/', consistency: 'strong' })]);
    const removed = new Set(purged.blobs.map(({ key }) => /^private\/purged-recipes\/([a-f0-9]{64})\.json$/.exec(key)?.[1]));
    const heads = new Map();
    for (const { key } of blobs) {
      const match = eventPattern.exec(key);
      if (!match || removed.has(match[1])) continue;
      const existing = heads.get(match[1]), generation = Number(match[2]);
      if (!existing || generation > existing.generation) heads.set(match[1], { key, generation, count: 1 });
      else if (generation === existing.generation) { existing.count++; if (key > existing.key) existing.key = key; }
    }
    return [...heads.entries()].map(([id, item]) => [id, item.key, item.count]).sort(([a], [b]) => a.localeCompare(b));
  }
  async read(key) { return this.store.get(key, { type: 'json', consistency: 'strong' }); }
  async latest(id) { const heads = await this.headKeys(`recipes/${hash(id)}/`); return heads.length ? { ...await this.read(heads[0][1]), conflictCount: heads[0][2] } : null; }
  async list(cursor = '') {
    const keys = (await this.headKeys()).filter(([id]) => id > cursor);
    // Keep a response comfortably below the cloud function body limit.
    const chosen = keys.slice(0, 100);
    const loaded = await Promise.all(chosen.map(async ([, key, count]) => ({ ...await this.read(key), conflictCount: count })));
    const items = []; let bytes = 0, consumed = 0;
    for (const item of loaded) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 384 * 1024) break;
      items.push(item); bytes += size; consumed++;
    }
    return { items: items.filter(item => item.id), cursor: keys.length > consumed ? chosen[consumed - 1][0] : null };
  }
  async photo(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    const image = await this.photos.get(key);
    return image ? joinPhoto(image) : null;
  }
  async commit({ id, recipe = null, baseRevision, mutationId, auditEntry, photoHash: reusedPhotoHash = '' }) {
    if (await this.read(purgeKey(id))) throw purgedError();
    if (baseRevision !== null && (typeof baseRevision !== 'string' || !baseRevision.startsWith(`recipes/${hash(id)}/`) || !eventPattern.test(baseRevision))) throw new ConflictError();
    const digest = hash(JSON.stringify({ id, recipe, baseRevision, ...(reusedPhotoHash ? { photoHash: reusedPhotoHash } : {}) }));
    const { blobs } = await this.store.list({ prefix: `recipes/${hash(id)}/`, consistency: 'strong' });
    const previousKey = blobs.find(item => item.key.endsWith(`-${mutationId}.json`))?.key;
    const previousAttempt = previousKey ? await this.read(previousKey) : null;
    if (previousAttempt) {
      if (previousAttempt.digest !== digest) throw new ConflictError('同一次保存请求的内容发生了变化，请重新保存。');
      return previousAttempt;
    }
    const current = await this.latest(id);
    if ((current?.revision || null) !== baseRevision) throw new ConflictError();
    if (reusedPhotoHash && (!recipe || recipe.photo || reusedPhotoHash !== current?.photoHash)) throw new ConflictError('照片版本已变化，请同步后重新保存。');
    const revision = versionKey(id, generationOf(baseRevision) + 1, mutationId);
    let photoHash = reusedPhotoHash;
    if (recipe?.photo) {
      photoHash = hash(recipe.photo);
      // Same hash means identical content. Repeated writes are harmless.
      if (photoHash !== current?.photoHash) photoHash = await this.photos.save(recipe.photo);
    }
    const event = {
      id, revision, mutationId, digest, deleted: !recipe, photoHash,
      savedAt: new Date().toISOString(),
      ...(auditEntry ? { auditEntry } : {}),
      recipe: recipe ? { ...recipe, photo: '', createdAt: current?.recipe?.createdAt || recipe.createdAt, updatedAt: new Date().toISOString() } : null,
    };
    await this.store.setJSON(revision, event, { cacheControl: 'no-store' });
    // A purge marker wins over an already-running restore. Recheck after the
    // immutable write (which also invalidates the per-request read cache).
    if (await this.read(purgeKey(id))) { await this.store.delete(revision); throw purgedError(); }
    return event;
  }
  async history(id) {
    if (await this.read(purgeKey(id))) return [];
    const { blobs } = await this.store.list({ prefix: `recipes/${hash(id)}/`, consistency: 'strong' });
    const keys = blobs.map(item => item.key).filter(key => eventPattern.test(key)).sort().reverse().slice(0, 10);
    return Promise.all(keys.map(key => this.read(key)));
  }
  async trash(cursor = '') {
    const page = await this.list(cursor);
    const items = await Promise.all(page.items.filter(item => item.deleted).map(async item => {
      const { blobs } = await this.store.list({ prefix: `recipes/${hash(item.id)}/`, consistency: 'strong' });
      const keys = blobs.map(entry => entry.key).filter(key => eventPattern.test(key) && key < item.revision).sort().reverse();
      for (const key of keys) {
        const version = await this.read(key);
        if (version?.recipe && !version.deleted) return { id: item.id, revision: item.revision, deletedAt: item.savedAt, title: version.recipe.title, version: key };
      }
      return { id: item.id, revision: item.revision, deletedAt: item.savedAt, title: '未命名菜谱', version: null };
    }));
    if (!cursor) {
      const { blobs } = await this.store.list({ prefix: 'private/purged-recipes/', consistency: 'strong' });
      const pending = await Promise.all(blobs.map(({ key }) => this.read(key)));
      for (const item of pending) if (item && !item.complete) items.unshift({ id: item.id, revision: item.baseRevision, deletedAt: item.purgedAt, title: item.title || '删除未完成的菜谱', version: null, purging: true });
    }
    return { items, cursor: page.cursor };
  }
  async purge(id, baseRevision, auditEntry) {
    const key = purgeKey(id);
    let marker = await this.read(key);
    if (!marker) {
      const current = await this.latest(id);
      if (!current?.deleted || current.revision !== baseRevision) throw new ConflictError('菜谱已被恢复或发生变化，请刷新回收站后重试。');
      const versions = await this.history(id);
      marker = { id, baseRevision, title: versions.find(item => item?.recipe)?.recipe.title || '已删除菜谱', purgedAt: new Date().toISOString(), complete: false, auditEntry };
      await this.store.setJSON(key, marker, { cacheControl: 'no-store' });
    }
    if (marker.baseRevision !== baseRevision) throw new ConflictError();
    // Durable marker prevents stale edits/backup imports from resurrecting this
    // ID, including after a timeout. Bounded deletion resumes from the same key.
    const [versions, favorites] = await Promise.all([
      this.store.list({ prefix: `recipes/${hash(id)}/`, consistency: 'strong' }),
      this.store.list({ prefix: 'private/favorites/', consistency: 'strong' }),
    ]);
    const keys = [...versions.blobs.map(item => item.key).filter(key => eventPattern.test(key)), ...favorites.blobs.map(item => item.key).filter(key => new RegExp(`^private/favorites/usr_[a-f0-9]{32}/${hash(id)}/[0-9]{13}-[a-zA-Z0-9-]+\\.json$`).test(key))];
    const batch = keys.slice(0, 64);
    for (let index = 0; index < batch.length; index += 8) {
      const results = await Promise.allSettled(batch.slice(index, index + 8).map(path => this.store.delete(path)));
      if (results.some(result => result.status === 'rejected')) throw Object.assign(new Error('部分历史记录尚未清理，请在回收站继续彻底删除。'), { status: 503, code: 'PURGE_INCOMPLETE' });
    }
    const complete = keys.length <= batch.length;
    if (complete && !marker.complete) await this.store.setJSON(key, { ...marker, title: '', complete: true }, { cacheControl: 'no-store' });
    return { complete, auditEntry: marker.auditEntry };
  }
  async version(id, revision) {
    if (await this.read(purgeKey(id))) return null;
    if (typeof revision !== 'string' || !eventPattern.test(revision) || !revision.startsWith(`recipes/${hash(id)}/`)) return null;
    return this.read(revision);
  }
}
