import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export class ConflictError extends Error {
  constructor(message = '这道菜已在另一台设备更新，请同步后再编辑。当前修改尚未保存。') { super(message); this.status = 409; this.code = 'CONFLICT'; }
}
const eventPattern = /^recipes\/([a-f0-9]{64})\/(\d{12})-\d{13}-[a-zA-Z0-9-]{8,200}\.json$/;
const versionKey = (id, generation, mutationId) => `recipes/${hash(id)}/${String(generation).padStart(12, '0')}-${Date.now()}-${randomUUID()}-${mutationId}.json`;
const generationOf = revision => Number(revision?.match(/\/(\d{12})-/)?.[1] || 0);

// Independent immutable versions: Blob's onlyIfNew is explicitly unsupported
// in SDK 0.0.18, so it MUST NOT be used as a lock/CAS. A stale editor is rejected
// on read; truly concurrent writes can form siblings, all of which are retained
// and exposed via the history UI. Generation + timestamp + ID picks the head.
export class RecipeDatabase {
  constructor(store) { this.store = store; }
  async headKeys(prefix = 'recipes/') {
    const { blobs } = await this.store.list({ prefix, consistency: 'strong' });
    const heads = new Map();
    for (const { key } of blobs) {
      const match = eventPattern.exec(key);
      if (!match) continue;
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
    const chosen = keys.slice(0, 20);
    const items = await Promise.all(chosen.map(async ([, key, count]) => ({ ...await this.read(key), conflictCount: count })));
    return { items: items.filter(Boolean), cursor: keys.length > chosen.length ? chosen.at(-1)[0] : null };
  }
  async photo(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    return this.store.get(`photos/${key}.txt`, { consistency: 'strong' });
  }
  async commit({ id, recipe = null, baseRevision, mutationId }) {
    if (baseRevision !== null && (typeof baseRevision !== 'string' || !baseRevision.startsWith(`recipes/${hash(id)}/`) || !eventPattern.test(baseRevision))) throw new ConflictError();
    const digest = hash(JSON.stringify({ id, recipe, baseRevision }));
    const { blobs } = await this.store.list({ prefix: `recipes/${hash(id)}/`, consistency: 'strong' });
    const previousKey = blobs.find(item => item.key.endsWith(`-${mutationId}.json`))?.key;
    const previousAttempt = previousKey ? await this.read(previousKey) : null;
    if (previousAttempt) {
      if (previousAttempt.digest !== digest) throw new ConflictError('同一次保存请求的内容发生了变化，请重新保存。');
      return previousAttempt;
    }
    const current = await this.latest(id);
    if ((current?.revision || null) !== baseRevision) throw new ConflictError();
    const revision = versionKey(id, generationOf(baseRevision) + 1, mutationId);
    let photoHash = '';
    if (recipe?.photo) {
      photoHash = hash(recipe.photo);
      // Same hash means identical content. Repeated writes are harmless.
      await this.store.set(`photos/${photoHash}.txt`, recipe.photo, { cacheControl: 'no-store' });
    }
    const event = {
      id, revision, mutationId, digest, deleted: !recipe, photoHash,
      savedAt: new Date().toISOString(),
      recipe: recipe ? { ...recipe, photo: '', createdAt: current?.recipe?.createdAt || recipe.createdAt, updatedAt: new Date().toISOString() } : null,
    };
    await this.store.setJSON(revision, event, { cacheControl: 'no-store' });
    return event;
  }
  async history(id) {
    const { blobs } = await this.store.list({ prefix: `recipes/${hash(id)}/`, consistency: 'strong' });
    const keys = blobs.map(item => item.key).filter(key => eventPattern.test(key)).sort().reverse().slice(0, 10);
    return Promise.all(keys.map(key => this.read(key)));
  }
}
