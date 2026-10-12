import { createHash } from 'node:crypto';

const accountPrefixes = ['private/users/', 'private/usernames/', 'private/registrations/', 'private/password-changes/', 'private/password-heads/'];
const probePrefix = 'private/registration-storage-check';
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
  }
  async checkBinding() {
    if (!this.bindingCheck) this.bindingCheck = (async () => {
      const previous = await this.source.get(bindingKey, { type: 'json', consistency: 'strong' });
      if (previous && (previous.backend !== this.binding.backend || previous.project !== this.binding.project || previous.namespace !== this.namespace)) throw unavailable('ACCOUNT_DATABASE_CHANGED');
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
    if (!record && !key.startsWith(probePrefix)) {
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
    const keys = new Set((await this.source.list(options)).blobs.map(item => item.key));
    const limit = 1000;
    for (let offset = 0; ; offset += limit) {
      // C collation in the SQL schema makes this a literal prefix range,
      // including underscores, without SQL LIKE wildcard interpretation.
      const query = [['namespace', `eq.${this.namespace}`], ['select', 'namespace,key,value'], ['order', 'key.asc'], ['limit', String(limit)], ['offset', String(offset)]];
      if (prefix) query.push(['key', `gte.${prefix}`], ['key', `lt.${prefix}\uffff`]);
      const rows = await this.request('GET', query);
      for (const row of rows) if (row.key.startsWith(prefix)) keys.add(row.key);
      if (rows.length < limit) break;
    }
    return { blobs: [...keys].sort().map(key => ({ key })) };
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
    if (options.onlyIfNew && !key.startsWith(probePrefix)) {
      // Import a pre-existing Blob reservation before attempting SQL INSERT.
      // The unique primary key selects one winner across concurrent instances.
      const previous = await this.source.get(key, { type: 'json', consistency: 'strong' });
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
