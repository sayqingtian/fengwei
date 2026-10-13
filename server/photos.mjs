import { createHash, randomUUID } from 'node:crypto';
import { PHOTO_TYPES, splitPhoto, joinPhoto } from '../dist/photo-wire.js';
const digest = photo => createHash('sha256').update(photo).digest('hex');
const validHash = key => /^[a-f0-9]{64}$/.test(key);
const aliasKey = key => `private/photo-optimizations/${key}.json`;
export class Photos {
  constructor(store) { this.store = store; }
  async raw(key) {
    if (!validHash(key)) return null;
    const binary = await this.store.get(`photos/${key}.bin`, { type: 'arrayBuffer', consistency: 'strong' });
    if (binary) {
      const bytes = new Uint8Array(binary);
      if (!PHOTO_TYPES[bytes[0]] || bytes.length < 2) throw new Error('Invalid stored photo');
      return { type: PHOTO_TYPES[bytes[0]], bytes: bytes.slice(1), storedBytes: bytes.length, legacy: false };
    }
    const legacy = await this.store.get(`photos/${key}.txt`, { consistency: 'strong' });
    return legacy ? { ...splitPhoto(legacy), storedBytes: Buffer.byteLength(legacy), legacy: true } : null;
  }
  async get(key) {
    const seen = new Set();
    while (validHash(key) && !seen.has(key) && seen.size < 10) {
      seen.add(key);
      const alias = await this.store.get(aliasKey(key), { type: 'json', consistency: 'strong' });
      if (!alias || alias.targetHash === key) return this.raw(key);
      key = alias.targetHash;
    }
    return null;
  }
  async save(photo) {
    const image = splitPhoto(photo), key = digest(photo);
    const existing = await this.raw(key);
    if (!existing || existing.legacy) {
      const bytes = new Uint8Array(image.bytes.length + 1); bytes[0] = PHOTO_TYPES.indexOf(image.type); bytes.set(image.bytes, 1);
      await this.store.set(`photos/${key}.bin`, bytes.buffer, { cacheControl: 'no-store' });
    }
    return key;
  }
  async inventory(cursor = '') {
    const { blobs } = await this.store.list({ prefix: 'photos/', consistency: 'strong' });
    const keys = [...new Set(blobs.map(({ key }) => /^photos\/([a-f0-9]{64})\.(?:txt|bin)$/.exec(key)?.[1]).filter(Boolean))].sort();
    const pending = keys.filter(key => key > cursor), chosen = pending.slice(0, 12);
    const paths = new Set(blobs.map(item => item.key));
    const duplicates = new Set(chosen.filter(key => paths.has(`photos/${key}.bin`) && paths.has(`photos/${key}.txt`)));
    const items = await Promise.all(chosen.map(async key => {
      const [image, optimized] = await Promise.all([this.raw(key), this.store.get(`private/photo-optimized/${key}.json`, { type: 'json', consistency: 'strong' })]);
      const extra = duplicates.has(key) ? await this.store.get(`photos/${key}.txt`, { consistency: 'strong' }) : '';
      return image && { hash: key, bytes: image.storedBytes + Buffer.byteLength(extra || ''), format: image.type, legacy: image.legacy, optimized: !!optimized && !image.legacy && !extra };
    }));
    return { items: items.filter(Boolean), total: keys.length, cursor: pending.length > chosen.length ? chosen.at(-1) : null };
  }
  async optimize(key, photo, auditEntry) {
    if (!validHash(key)) throw Object.assign(new Error('照片编号不正确。'), { status: 400 });
    const previous = await this.store.get(aliasKey(key), { type: 'json', consistency: 'strong' });
    if (previous) {
      const image = await this.get(key);
      if (!image) throw new Error('Photo optimization target unavailable');
      await this.store.setJSON(`private/photo-optimized/${previous.targetHash}.json`, { version: 1 }, { cacheControl: 'no-store' });
      await this.store.delete(`photos/${key}.txt`);
      if (key !== previous.targetHash) await this.store.delete(`photos/${key}.bin`);
      await this.store.setJSON('private/photo-cache-version.json', { version: randomUUID() }, { cacheControl: 'no-store' });
      return { ...previous, changed: false, savedBytes: 0 };
    }
    const original = await this.raw(key);
    if (!original) throw Object.assign(new Error('照片不存在。'), { status: 404 });
    const duplicate = !original.legacy && await this.store.get(`photos/${key}.txt`, { consistency: 'strong' });
    const originalBytes = original.storedBytes + Buffer.byteLength(duplicate || '');
    const candidate = splitPhoto(photo);
    if (candidate.bytes.length > 160 * 1024) throw Object.assign(new Error('优化后的照片不能超过 160 KB。'), { status: 413 });
    const selected = candidate.bytes.length < original.bytes.length ? candidate : original;
    const selectedPhoto = joinPhoto(selected), candidateHash = digest(selectedPhoto);
    const alreadyStored = candidateHash !== key && await this.raw(candidateHash);
    const targetHash = await this.save(selectedPhoto);
    // Read the actual object again before committing the reference or deleting a source.
    const confirmed = await this.raw(targetHash);
    if (!confirmed || confirmed.type !== selected.type || !Buffer.from(confirmed.bytes).equals(Buffer.from(selected.bytes))) throw new Error('Photo verification failed');
    const addedBytes = !alreadyStored || alreadyStored.legacy ? confirmed.storedBytes : 0;
    const receipt = { sourceHash: key, targetHash, originalBytes, bytes: confirmed.storedBytes, savedBytes: Math.max(0, originalBytes - addedBytes), version: 1, optimizedAt: new Date().toISOString(), auditEntry };
    await this.store.setJSON(aliasKey(key), receipt, { cacheControl: 'no-store' });
    const saved = await this.store.get(aliasKey(key), { type: 'json', consistency: 'strong' });
    if (saved?.targetHash !== targetHash) throw new Error('Photo reference verification failed');
    await this.store.setJSON(`private/photo-optimized/${targetHash}.json`, { version: 1 }, { cacheControl: 'no-store' });
    // All current and historical recipe references resolve through this durable map.
    // An interrupted cleanup is safe to retry; no recipe/history event is rewritten.
    await this.store.delete(`photos/${key}.txt`);
    if (key !== targetHash) await this.store.delete(`photos/${key}.bin`);
    await this.store.setJSON('private/photo-cache-version.json', { version: randomUUID() }, { cacheControl: 'no-store' });
    return { ...receipt, changed: true };
  }
}
