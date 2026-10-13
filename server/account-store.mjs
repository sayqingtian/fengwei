import { canPruneAudit, isAuditObject, retainedRecord } from './audit-retention.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { AUDIT_PREFIX, auditTerms } from './audit-index.mjs';

const removableRecipeObject = key => /^recipes\/[a-f0-9]{64}\/\d{12}-\d{13}-[a-zA-Z0-9-]{8,200}\.json$/.test(key) || /^private\/favorites\/usr_[a-f0-9]{32}\/[a-f0-9]{64}\/\d{13}-[a-zA-Z0-9-]+\.json$/.test(key);
const accountPrefixes = ['private/users/', 'private/usernames/', 'private/registrations/', 'private/password-changes/', 'private/password-heads/', 'private/account-migrations/', 'private/password-recovery-requests/', 'private/password-recovery-decisions/', 'private/password-recovery-limits/', 'private/deleted-users/', 'private/rate-limits/', 'private/audit-index/', 'private/audit-canonical/', 'private/audit-migration/'];
const probePrefix = 'private/registration-storage-check';
const sqlOnly = key => /^private\/(rate-limits|audit-index|audit-canonical|audit-migration)\//.test(key);
const bindingKey = 'private/account-database-binding.json';
const isAccountKey = key => accountPrefixes.some(prefix => key.startsWith(prefix)) || key.startsWith(probePrefix);
const includesAccounts = prefix => isAccountKey(prefix) || accountPrefixes.some(path => path.startsWith(prefix)) || probePrefix.startsWith(prefix);
const unavailable = code => Object.assign(new Error('账号服务暂时不可用，请稍后重试或联系管理员。'), { status: 503, code });
const notConfigured = () => Object.assign(new Error('注册服务尚未完成配置，请联系管理员。'), { status: 503, code: 'ACCOUNT_DATABASE_NOT_CONFIGURED' });

export function createAccountStore(source, { url, secretKey, namespace = 'fengwei-recipes', fetch: send = globalThis.fetch } = {}) {
  if (!url || !secretKey) {
    // Existing Blob accounts can still log in during initial setup. Once SQL
    // has been used, never fall back to old Blob credentials on misconfiguration.
    async function requireUnmigrated() {
      const binding = await source.get(bindingKey, { type: 'json', consistency: 'strong' });
      if (binding) throw notConfigured();
    }
    return {
      async get(key, options) { if (isAccountKey(key)) await requireUnmigrated(); return source.get(key, options); },
      async list(options = {}) { if (includesAccounts(options.prefix || '')) await requireUnmigrated(); return source.list(options); },
      async set(key, value, options = {}) {
        if (options.onlyIfNew) throw notConfigured();
        if (isAccountKey(key)) await requireUnmigrated();
        return source.set(key, value, options);
      },
      async setJSON(key, value, options = {}) {
        if (options.onlyIfNew) throw notConfigured();
        if (isAccountKey(key)) await requireUnmigrated();
        return source.setJSON(key, value, options);
      },
      async delete(key) { if (!isAuditObject(key) && !removableRecipeObject(key) && !/^photos\/[a-f0-9]{64}\.(txt|bin)$/.test(key)) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY'); return source.delete(key); },
    };
  }
  return new SupabaseAccountStore(source, { url, secretKey, namespace, send });
}

class SupabaseAccountStore {
  constructor(source, { url, secretKey, namespace, send }) {
    let origin;
    try { origin = new URL(url); }
    catch { throw unavailable('ACCOUNT_DATABASE_INVALID_CONFIG'); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || typeof secretKey !== 'string' || !secretKey.trim() || typeof namespace !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw unavailable('ACCOUNT_DATABASE_INVALID_CONFIG');
    this.source = source; this.url = new URL('/rest/v1/fengwei_account_records', origin);
    this.secretKey = secretKey; this.namespace = namespace; this.send = send;
    this.binding = { backend: 'supabase', project: createHash('sha256').update(origin.origin).digest('hex'), namespace };
    this.readyAccounts = new Set();
  }
  async checkBinding() {
    if (!this.bindingCheck) this.bindingCheck = (async () => {
      const previous = await this.source.get(bindingKey, { type: 'json', consistency: 'strong' });
      if (previous && (previous.backend !== this.binding.backend || previous.project !== this.binding.project || previous.namespace !== this.namespace)) throw unavailable('ACCOUNT_DATABASE_CHANGED');
      if (previous) this.bindingSaved ||= Promise.resolve();
    })();
    try { await this.bindingCheck; }
    catch (error) { this.bindingCheck = null; throw error; }
  }
  async request(method, query, body, prefer) {
    await this.checkBinding();
    const target = new URL(this.url);
    for (const [name, value] of query) target.searchParams.append(name, value);
    const headers = { apikey: this.secretKey, Accept: 'application/json', 'Content-Type': 'application/json' };
    // Modern sb_secret keys use apikey only; legacy service_role JWTs also
    // require Bearer authorization. Neither key is sent to the browser.
    if (this.secretKey.startsWith('eyJ')) headers.Authorization = `Bearer ${this.secretKey}`;
    if (prefer) headers.Prefer = prefer;
    let response;
    try { response = await this.send(target, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) }); }
    catch { throw unavailable('ACCOUNT_DATABASE_CONNECTION_FAILED'); }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw unavailable('ACCOUNT_DATABASE_AUTH_FAILED');
      if (response.status === 404) throw unavailable('ACCOUNT_DATABASE_SCHEMA_REQUIRED');
      // Do not return SQL errors, request bodies, or credentials to clients.
      throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
    }
    let records;
    try { records = await response.json(); }
    catch { throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE'); }
    if (!Array.isArray(records) || records.some(row => row?.namespace !== this.namespace || typeof row.key !== 'string' || !Object.hasOwn(row, 'value'))) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
    if (!this.bindingSaved) this.bindingSaved = this.source.setJSON(bindingKey, this.binding, { cacheControl: 'no-store' });
    try { await this.bindingSaved; }
    catch (error) { this.bindingSaved = null; throw error; }
    return records;
  }
  async readRecord(key) {
    const rows = await this.request('GET', [['namespace', `eq.${this.namespace}`], ['key', `eq.${key}`], ['select', 'namespace,key,value'], ['limit', '1']]);
    if (rows.length > 1 || (rows.length && rows[0].key !== key)) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
    return rows[0] || null;
  }
  async consumeRateLimit(key, { limit, windowMs, now }) {
    if (!key.startsWith('private/rate-limits/')) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
    for (let attempt = 0; attempt < 40; attempt++) {
      const previous = await this.readRecord(key), state = previous?.value;
      const active = state?.expires > now;
      if (active && state.count >= limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((state.expires - now) / 1000)) };
      const value = { count: (active ? state.count : 0) + 1, expires: active ? state.expires : now + windowMs, version: randomUUID() };
      if (!previous) {
        if (await this.writeRecord(key, value, true)) return { allowed: true };
      } else {
        if (typeof state?.version !== 'string' || !Number.isSafeInteger(state.count) || !Number.isFinite(state.expires)) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
        const rows = await this.request('PATCH', [['namespace', `eq.${this.namespace}`], ['key', `eq.${key}`], ['value->>version', `eq.${state.version}`], ['select', 'namespace,key,value']], { value }, 'return=representation');
        if (rows.length === 1 && rows[0].key === key && rows[0].value.version === value.version) return { allowed: true };
        if (rows.length) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
      }
    }
    throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
  }
  async queryAudit({ cursor = '', query = '', result = '', from = '', to = '', limit = 51 } = {}) {
    const filters = [['namespace', `eq.${this.namespace}`], ['key', `gte.${AUDIT_PREFIX}${from}`], ['key', `lt.${AUDIT_PREFIX}${to || '\uffff'}`], ['order', 'key.desc'], ['limit', String(limit)], ['select', 'namespace,key,value']];
    if (cursor) filters.push(['key', `lt.${AUDIT_PREFIX}${cursor}.json`]);
    if (result) filters.push(['value->>result', `eq.${result}`]);
    // Escaped regex preserves literal text, including PostgREST's LIKE '*' alias.
    for (const term of auditTerms(query)) filters.push(['value->>searchText', `match.${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`]);
    const rows = await this.request('GET', filters);
    return rows.map(row => row.value);
  }
  async clearAuditPending(key) {
    if (!/^private\/audit-pending\/[a-f0-9]{64}\.json$/.test(key)) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
    if (this.source.delete) await this.source.delete(key);
  }
  async delete(key) {
    if (!isAuditObject(key) && !removableRecipeObject(key) && !/^photos\/[a-f0-9]{64}\.(txt|bin)$/.test(key)) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
    if (isAccountKey(key)) await this.request('DELETE', [['namespace', `eq.${this.namespace}`], ['key', `eq.${key}`], ['select', 'namespace,key,value']], undefined, 'return=representation');
    await this.source.delete(key);
  }
  async checkAuditDelete() {
    // Permission probe cannot match a real log key (which is a SHA-256 ID or
    // timestamp plus SHA-256). No production record is created or removed.
    await this.request('DELETE', [['namespace', `eq.${this.namespace}`], ['key', `eq.private/audit-index/delete-permission-probe-${randomUUID()}.json`], ['select', 'namespace,key,value']], undefined, 'return=representation');
  }
  async pruneAuditRecord(key, cutoff) {
    if (!canPruneAudit(key)) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
    // Clean legacy Blob copies as well as SQL; stale credentials/receipts must
    // not be resurrected if a SQL record is read or migrated later.
    const clean = async (value, write, remove) => {
      if (!value) return;
      const next = retainedRecord(key, value, cutoff);
      if (next === null) await remove(); else if (next !== value) await write(next);
    };
    if (isAccountKey(key)) {
      const row = await this.readRecord(key);
      await clean(row?.value, value => this.writeRecord(key, value, false), () => this.request('DELETE', [['namespace', `eq.${this.namespace}`], ['key', `eq.${key}`], ['select', 'namespace,key,value']], undefined, 'return=representation'));
    }
    const legacy = await this.source.get(key, { type: 'json', consistency: 'strong' });
    await clean(legacy, value => this.source.setJSON(key, value, { cacheControl: 'no-store' }), () => this.source.delete(key));
  }
  async accountSnapshot(id) {
    if (!/^usr_[a-f0-9]{32}$/.test(id)) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
    const changes = `private/password-changes/${id}/`, marker = `private/account-migrations/${id}.json`;
    const fixed = [`private/users/${id}.json`, `private/registrations/${id}.json`, `private/password-heads/${id}.json`, marker, `private/deleted-users/${id}.json`];
    const matches = key => fixed.includes(key) || key.startsWith(changes);
    const read = async () => {
      const records = new Map();
      for (let offset = 0; ; offset += 1000) {
        const query = [['namespace', `eq.${this.namespace}`], ['select', 'namespace,key,value'], ['order', 'key.asc'], ['limit', '1000'], ['offset', String(offset)], ['or', `(${fixed.map(key => `key.eq.${key}`).join(',')},and(key.gte.${changes},key.lt.${changes}\uffff))`]];
        const rows = await this.request('GET', query);
        if (rows.some(row => !matches(row.key))) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
        for (const row of rows) records.set(row.key, row.value);
        if (rows.length < 1000) return records;
      }
    };
    let records = await read();
    if (records.has(marker) && records.get(marker)?.version !== 1) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
    if (records.get(marker)?.version !== 1) {
      // Import the complete legacy credential chain once before relying on a
      // single fresh SQL snapshot. Missing Blob keys then need no repeated IO.
      const legacyKeys = [fixed[0], fixed[1], fixed[2], fixed[4]];
      const [values, history] = await Promise.all([
        Promise.all(legacyKeys.map(key => this.source.get(key, { type: 'json', consistency: 'strong' }))),
        this.source.list({ prefix: changes, consistency: 'strong' }),
      ]);
      const imports = legacyKeys.map((key, index) => [key, values[index]]);
      const previous = await Promise.all(history.blobs.filter(({ key }) => !records.has(key)).map(async ({ key }) => [key, await this.source.get(key, { type: 'json', consistency: 'strong' })]));
      imports.push(...previous);
      // Unknown login IDs must remain read-only rather than create migration rows.
      if (!records.size && imports.every(([, value]) => value == null)) return records;
      await Promise.all(imports.filter(([key, value]) => !records.has(key) && value != null).map(([key, value]) => this.writeRecord(key, value, true)));
      await this.writeRecord(marker, { version: 1 }, true);
      records = await read();
      if (records.get(marker)?.version !== 1) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
    }
    this.readyAccounts.add(id);
    return records;
  }
  async writeRecord(key, value, onlyIfNew) {
    const rows = await this.request('POST', [['on_conflict', 'namespace,key'], ['select', 'namespace,key,value']], { namespace: this.namespace, key, value }, `resolution=${onlyIfNew ? 'ignore' : 'merge'}-duplicates,return=representation`);
    if (!rows.length && onlyIfNew) return false;
    if (rows.length !== 1 || rows[0].key !== key || JSON.stringify(rows[0].value) !== JSON.stringify(value)) {
      // PostgreSQL JSONB may reorder object properties; compare normalized JSON.
      if (rows.length !== 1 || rows[0].key !== key || JSON.stringify(canonical(rows[0].value)) !== JSON.stringify(canonical(value))) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
    }
    return true;
  }
  async get(key, options = {}) {
    if (!isAccountKey(key)) return this.source.get(key, options);
    let record = await this.readRecord(key);
    if (!record && !key.startsWith(probePrefix) && !sqlOnly(key)) {
      const previous = await this.source.get(key, { type: 'json', consistency: 'strong' });
      if (previous !== null && previous !== undefined) {
        await this.writeRecord(key, previous, true);
        record = await this.readRecord(key);
        if (!record) throw unavailable('ACCOUNT_DATABASE_UNAVAILABLE');
      }
    }
    return record ? options.type === 'json' ? record.value : JSON.stringify(record.value) : null;
  }
  async list(options = {}) {
    const prefix = options.prefix || '';
    if (!includesAccounts(prefix)) return this.source.list(options);
    const keys = new Set(sqlOnly(prefix) ? [] : (await this.source.list(options)).blobs.map(item => item.key)), values = new Map();
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      // C collation in the SQL schema makes this a literal prefix range,
      // including underscores, without SQL LIKE wildcard interpretation.
      const query = [['namespace', `eq.${this.namespace}`], ['select', 'namespace,key,value'], ['order', 'key.asc'], ['limit', String(limit)], ['offset', String(offset)]];
      if (prefix) query.push(['key', `gte.${prefix}`], ['key', `lt.${prefix}\uffff`]);
      const rows = await this.request('GET', query);
      for (const row of rows) if (row.key.startsWith(prefix)) { keys.add(row.key); values.set(row.key, row.value); }
      if (rows.length < limit) break;
    }
    return { blobs: [...keys].sort().map(key => ({ key })), records: values };
  }
  set(key, value, options = {}) {
    if (!isAccountKey(key)) {
      if (options.onlyIfNew) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
      return this.source.set(key, value, options);
    }
    return this.setJSON(key, JSON.parse(value), options);
  }
  async setJSON(key, value, options = {}) {
    if (!isAccountKey(key)) {
      if (options.onlyIfNew) throw unavailable('ACCOUNT_DATABASE_UNSUPPORTED_KEY');
      return this.source.setJSON(key, value, options);
    }
    if (options.onlyIfNew && !key.startsWith(probePrefix) && !sqlOnly(key)) {
      // Import a pre-existing Blob reservation before attempting SQL INSERT.
      // The unique primary key selects one winner across concurrent instances.
      const migratedId = /^private\/(?:users|registrations|password-heads|password-changes)\/(usr_[a-f0-9]{32})(?:\/|\.json$)/.exec(key)?.[1];
      const previous = migratedId && this.readyAccounts.has(migratedId) ? null : await this.source.get(key, { type: 'json', consistency: 'strong' });
      if (previous !== null && previous !== undefined) await this.writeRecord(key, previous, true);
    }
    if (!await this.writeRecord(key, value, !!options.onlyIfNew)) throw Object.assign(new Error('Account record already exists.'), { code: 'PRECONDITION_FAILED' });
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
