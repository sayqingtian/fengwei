import { AsyncLocalStorage } from 'node:async_hooks';
import { indexAudit } from './audit-index.mjs';

const immutable = key => /^recipes\/[a-f0-9]{64}\/\d{12}-\d{13}-[a-zA-Z0-9-]+\.json$/.test(key) || /^private\/auth\/[a-f0-9]{64}\/\d{13}-[a-f0-9-]{36}\.json$/.test(key) || /^private\/permissions\/usr_[a-f0-9]{32}\/\d{12}-\d{13}-[a-zA-Z0-9-]+\.json$/.test(key) || /^private\/favorites\/usr_[a-f0-9]{32}\/[a-f0-9]{64}\/\d{13}-[a-zA-Z0-9-]+\.json$/.test(key);

export function requestStore(source) {
  const context = new AsyncLocalStorage(), retained = new Map();
  let bytes = 0;
  const clone = value => value === undefined ? undefined : structuredClone(value);
  function retain(key, value) {
    if (value === null || value === undefined) return;
    const size = value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? value.byteLength : Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
    if (size > 8 * 1024 * 1024) return;
    const previous = retained.get(key); if (previous) { bytes -= previous.size; retained.delete(key); }
    retained.set(key, { value: clone(value), size, expires: Date.now() + 300000 }); bytes += size;
    while (bytes > 8 * 1024 * 1024 || retained.size > 128) { const [oldest, item] = retained.entries().next().value; bytes -= item.size; retained.delete(oldest); }
  }
  async function memo(bucket, key, load) {
    const scope = context.getStore();
    if (!scope) return load();
    const cache = scope[bucket];
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(load).catch(error => { cache.delete(key); throw error; }));
    return clone(await cache.get(key));
  }
  function invalidate() { const scope = context.getStore(); if (scope) for (const cache of Object.values(scope)) cache.clear(); }
  function evict(key) { for (const [cacheKey, item] of retained) if (JSON.parse(cacheKey)[0] === key) { bytes -= item.size; retained.delete(cacheKey); } }
  async function indexReceipt(key, value) {
    if (!source.queryAudit) return;
    const entry = key.startsWith('private/audit/') ? value : value?.auditEntry;
    if (!entry) return;
    try { await indexAudit(source, entry); }
    catch (error) {
      // The business record remains authoritative. Queue a small retry in Blob
      // if SQL indexing is temporarily unavailable; never report a saved edit as lost.
      console.error('Fengwei audit search index unavailable:', error.code || error.name);
      try { await source.setJSON(`private/audit-pending/${entry.id}.json`, entry, { cacheControl: 'no-store' }); }
      catch (failure) { console.error('Fengwei audit retry unavailable:', failure.code || failure.name); }
    }
  }
  const store = {
    run: work => context.run({ reads: new Map(), lists: new Map(), accounts: new Map() }, work),
    async get(key, options = {}) {
      const cacheKey = JSON.stringify([key, options]);
      return memo('reads', cacheKey, async () => {
        const id = /^private\/(?:users|registrations|password-heads|password-changes|deleted-users|account-emails)\/(usr_[a-f0-9]{32})(?:\/|\.json$)/.exec(key)?.[1];
        const snapshot = id && context.getStore()?.accounts.get(id);
        if (snapshot) { const values = await snapshot; const value = values.get(key) ?? null; return options.type === 'json' ? clone(value) : value == null ? null : JSON.stringify(value); }
        if (immutable(key)) {
          const cached = retained.get(cacheKey);
          if (cached && cached.expires > Date.now()) { retained.delete(cacheKey); retained.set(cacheKey, cached); return clone(cached.value); }
          if (cached) { bytes -= cached.size; retained.delete(cacheKey); }
        }
        const value = await source.get(key, options);
        if (immutable(key)) retain(cacheKey, value);
        return value;
      });
    },
    async list(options = {}) {
      const result = await memo('lists', JSON.stringify(options), () => source.list(options));
      const scope = context.getStore();
      if (scope && result.records instanceof Map) for (const [path, value] of result.records) {
        const key = JSON.stringify([path, { type: 'json', consistency: 'strong' }]);
        if (!scope.reads.has(key)) scope.reads.set(key, Promise.resolve(clone(value)));
      }
      delete result.records;
      return result;
    },
    async set(key, value, options) { invalidate(); evict(key); const result = await source.set(key, value, options); invalidate(); return result; },
    async setJSON(key, value, options) { invalidate(); evict(key); const result = await source.setJSON(key, value, options); invalidate(); await indexReceipt(key, value); return result; },
    async delete(key) { invalidate(); const result = await source.delete(key); invalidate(); for (const [cacheKey, item] of retained) if (JSON.parse(cacheKey)[0] === key) { bytes -= item.size; retained.delete(cacheKey); } return result; },
  };
  if (source.photoLease) store.photoLease = command => source.photoLease(command);
  if (source.checkAuditDelete) store.checkAuditDelete = () => source.checkAuditDelete();
  if (source.pruneAuditRecord) store.pruneAuditRecord = async (key, cutoff) => { invalidate(); evict(key); try { return await source.pruneAuditRecord(key, cutoff); } finally { invalidate(); evict(key); } };
  if (source.accountSnapshot) store.accountSnapshot = id => memo('accounts', id, () => source.accountSnapshot(id));
  if (source.consumeRateLimit) store.consumeRateLimit = (key, options) => source.consumeRateLimit(key, options);
  if (source.queryAudit) {
    store.queryAudit = options => source.queryAudit(options);
    store.indexAudit = entry => indexAudit(source, entry);
    store.clearAuditPending = key => source.clearAuditPending?.(key);
  }
  return store;
}
