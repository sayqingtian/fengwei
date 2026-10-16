import { createHash, randomUUID } from 'node:crypto';
import { photoAccess } from './photo-access.mjs';
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
  async prune(candidates, remember, checkpoint, guard) {
    const scan = checkpoint?.generation === guard.generation ? checkpoint : { generation: guard.generation, phase: 'recipes/', cursor: '', used: [], aliases: [] };
    const used = new Set(scan.used), aliases = new Map(scan.aliases), started = Date.now();
    let processed = 0;
    // Resume bounded reference scans across requests. Any intervening upload or
    // optimization changes the lease generation and restarts the scan safely.
    while (scan.phase) {
      const { blobs } = await this.store.list({ prefix: scan.phase, consistency: 'strong' });
      const keys = blobs.map(item => item.key).filter(key => key > scan.cursor).sort();
      for (let offset = 0; offset < keys.length; offset += 16) {
        if (processed >= 128 || Date.now() - started > 6000) {
          await remember(candidates, { ...scan, used: [...used], aliases: [...aliases] }); return false;
        }
        await guard();
        const group = keys.slice(offset, offset + 16);
        await Promise.all(group.map(async key => {
          if (scan.phase === 'recipes/' && !/^recipes\/[a-f0-9]{64}\/\d{12}-\d{13}-[a-zA-Z0-9-]+\.json$/.test(key)) return;
          const value = await this.store.get(key, { type: 'json', consistency: 'strong' });
          if (!value) throw new Error('References changed; collection stopped');
          if (scan.phase === 'recipes/') {
            if (value.photoHash) { if (!validHash(value.photoHash)) throw new Error('Invalid photo reference'); used.add(value.photoHash); }
          } else {
            const source = /^private\/photo-optimizations\/([a-f0-9]{64})\.json$/.exec(key)?.[1];
            if (!source || !validHash(value.targetHash)) throw new Error('Invalid photo mapping; collection stopped');
            aliases.set(source, value.targetHash);
          }
        }));
        processed += group.length; scan.cursor = group.at(-1);
      }
      scan.phase = scan.phase === 'recipes/' ? 'private/photo-optimizations/' : null; scan.cursor = '';
    }
    // Protect full histories, including soft-deleted recipes and alias chains.
    for (const key of used) { const target = aliases.get(key); if (target) used.add(target); }
    const connected = new Set(candidates.filter(validHash));
    let changed;
    do { changed = false; for (const [source, target] of aliases) if (connected.has(source) || connected.has(target)) {
      if (!connected.has(source)) { connected.add(source); changed = true; }
      if (!connected.has(target)) { connected.add(target); changed = true; }
    } } while (changed);
    const unused = [...connected].filter(key => !used.has(key));
    await remember(unused); // Save expanded candidates before deleting aliases.
    const removed = new Set();
    for (const key of unused.slice(0, 8)) {
      await guard();
      await this.store.delete(aliasKey(key));
      await this.store.delete(`private/photo-optimized/${key}.json`);
      await this.store.delete(`photos/${key}.bin`);
      await this.store.delete(`photos/${key}.txt`);
      removed.add(key); await remember(unused.filter(item => !removed.has(item)));
    }
    return unused.length <= 8;
  }
  async inventory(cursor = '') {
    const [{ blobs }, usage] = await Promise.all([this.store.list({ prefix: 'photos/', consistency: 'strong' }), this.references()]);
    const keys = [...new Set(blobs.map(({ key }) => /^photos\/([a-f0-9]{64})\.(?:txt|bin)$/.exec(key)?.[1]).filter(Boolean))].sort();
    const pending = keys.filter(key => key > cursor), chosen = pending.slice(0, 12);
    const paths = new Set(blobs.map(item => item.key));
    const duplicates = new Set(chosen.filter(key => paths.has(`photos/${key}.bin`) && paths.has(`photos/${key}.txt`)));
    const items = await Promise.all(chosen.map(async key => {
      const [image, optimized] = await Promise.all([this.raw(key), this.store.get(`private/photo-optimized/${key}.json`, { type: 'json', consistency: 'strong' })]);
      const extra = duplicates.has(key) ? await this.store.get(`photos/${key}.txt`, { consistency: 'strong' }) : '';
      return image && { hash: key, bytes: image.storedBytes + Buffer.byteLength(extra || ''), format: image.type, legacy: image.legacy, optimized: !!optimized && !image.legacy && !extra, usage: usage.current.has(key) ? 'current' : usage.used.has(key) ? 'history' : 'orphan' };
    }));
    return { items: items.filter(Boolean), total: keys.length, cursor: pending.length > chosen.length ? chosen.at(-1) : null };
  }
  async references() {
    const [recipes, mappings] = await Promise.all([this.store.list({ prefix: 'recipes/', consistency: 'strong' }), this.store.list({ prefix: 'private/photo-optimizations/', consistency: 'strong' })]);
    const used = new Set(), current = new Set(), aliases = new Map(), heads = new Map();
    const events = recipes.blobs.flatMap(({ key }) => {
      const match = /^recipes\/([a-f0-9]{64})\/(\d{12})-\d{13}-[a-zA-Z0-9-]+\.json$/.exec(key);
      if (!match) return [];
      const generation = Number(match[2]); heads.set(match[1], Math.max(heads.get(match[1]) || 0, generation));
      return [{ key, id: match[1], generation }];
    });
    for (let offset = 0; offset < events.length; offset += 16) await Promise.all(events.slice(offset, offset + 16).map(async ({ key, id, generation }) => {
      const value = await this.store.get(key, { type: 'json', consistency: 'strong' });
      if (!value || value.photoHash && !validHash(value.photoHash)) throw new Error('Cannot verify photo references');
      if (value.photoHash) { used.add(value.photoHash); if (!value.deleted && generation === heads.get(id)) current.add(value.photoHash); }
    }));
    for (let offset = 0; offset < mappings.blobs.length; offset += 16) await Promise.all(mappings.blobs.slice(offset, offset + 16).map(async ({ key }) => {
      const source = /^private\/photo-optimizations\/([a-f0-9]{64})\.json$/.exec(key)?.[1], value = await this.store.get(key, { type: 'json', consistency: 'strong' });
      if (!source || !value || !validHash(value.targetHash)) throw new Error('Cannot verify photo mappings');
      aliases.set(source, value.targetHash);
    }));
    for (const set of [used, current]) for (const key of set) { const target = aliases.get(key); if (target) set.add(target); }
    return { used, current };
  }
  cleanup(userId, { hashes, mutationId }, auditEntry) {
    if (!Array.isArray(hashes) || !hashes.length || hashes.length > 100 || hashes.some(key => !validHash(key)) || typeof mutationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(mutationId)) throw Object.assign(new Error('图片清理请求不正确。'), { status: 400, code: 'INVALID_PHOTO_CLEANUP' });
    const requested = [...new Set(hashes)].sort(), key = `private/photo-cleanups/${digest(`${userId}:${mutationId}`)}.json`;
    return photoAccess(this.store, 'write', async guard => {
      let state = await this.store.get(key, { type: 'json', consistency: 'strong' });
      if (state && JSON.stringify(state.requested) !== JSON.stringify(requested)) throw Object.assign(new Error('清理内容已变化，请刷新图片统计。'), { status: 409 });
      state ||= { requested, candidates: requested, auditEntry };
      if (!state.complete) {
        const remember = async (candidates, scan = null) => {
          state = { ...state, candidates, scan };
          await this.store.setJSON(key, state, { cacheControl: 'no-store' });
        };
        const complete = await this.prune(state.candidates, remember, state.scan, guard);
        state = { ...state, complete };
        await this.store.setJSON(key, state, { cacheControl: 'no-store' });
      }
      return { complete: !!state.complete };
    });
  }
  optimize(key, photo, auditEntry) { return photoAccess(this.store, 'read', guard => this.optimizeLocked(key, photo, auditEntry, guard)); }
  async optimizeLocked(key, photo, auditEntry, guard) {
    if (!validHash(key)) throw Object.assign(new Error('照片编号不正确。'), { status: 400 });
    await guard();
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
    await guard();
    await this.store.setJSON(aliasKey(key), receipt, { cacheControl: 'no-store' });
    const saved = await this.store.get(aliasKey(key), { type: 'json', consistency: 'strong' });
    if (saved?.targetHash !== targetHash) throw new Error('Photo reference verification failed');
    await this.store.setJSON(`private/photo-optimized/${targetHash}.json`, { version: 1 }, { cacheControl: 'no-store' });
    await guard();
    // All current and historical recipe references resolve through this durable map.
    // An interrupted cleanup is safe to retry; no recipe/history event is rewritten.
    await this.store.delete(`photos/${key}.txt`);
    if (key !== targetHash) await this.store.delete(`photos/${key}.bin`);
    await this.store.setJSON('private/photo-cache-version.json', { version: randomUUID() }, { cacheControl: 'no-store' });
    return { ...receipt, changed: true };
  }
}
