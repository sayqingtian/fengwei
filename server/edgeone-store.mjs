import { createHash, createHmac } from 'node:crypto';

const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const storageError = code => Object.assign(new Error('Conditional account storage is unavailable.'), { code });

export function signCosRequest(method, key, headers, credential, query = {}) {
  const start = Math.floor(Date.now() / 1000);
  const time = `${start};${start + 3600}`;
  // Matches the pinned Blob SDK's COS signing rules. The temporary security
  // token is sent separately, as required by the COS API.
  const signed = Object.entries(headers).filter(([name]) => name !== 'x-cos-security-token' && name !== 'authorization').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const headerList = signed.map(([name]) => encode(name)).join(';');
  const headerString = signed.map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
  const parameters = Object.entries(query).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const parameterList = parameters.map(([name]) => encode(name)).join(';');
  const parameterString = parameters.map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
  const httpString = `${method.toLowerCase()}\n/${key}\n${parameterString}\n${headerString}\n`;
  const signKey = createHmac('sha1', credential.secretKey).update(time).digest('hex');
  const stringToSign = `sha1\n${time}\n${createHash('sha1').update(httpString).digest('hex')}\n`;
  const signature = createHmac('sha1', signKey).update(stringToSign).digest('hex');
  return `q-sign-algorithm=sha1&q-ak=${credential.secretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${headerList}&q-url-param-list=${parameterList}&q-signature=${signature}`;
}

// Versioned COS buckets ignore forbid-overwrite. APPEND at position=0 instead
// creates a nonempty record once; later position=0 requests fail atomically.
// Existing normal objects also reject APPEND, so old account claims stay intact.
// Blob reads and ordinary writes keep using the existing namespace and keys.
// requireUniqueWrites still tests this path and refuses unsafe providers.
export function withAtomicWrites(store, { fetch: send = globalThis.fetch } = {}) {
  async function createOnly(key, value, options, contentType) {
    if (typeof key !== 'string' || !key || key.startsWith('/') || key.includes('\\') || key.split('/').some(part => part === '.' || part === '..')) throw storageError('INVALID_KEY');
    // These internals belong to the exactly pinned @edgeone/pages-blob 0.0.18.
    // Check their shape instead of silently falling back to an ordinary write.
    const client = store.cosClient;
    if (typeof client?.ensureInitialized !== 'function' || typeof client?.resolveCredential !== 'function' || typeof client?.buildCosKey !== 'function') throw storageError('ATOMIC_STORAGE_UNAVAILABLE');
    await client.ensureInitialized();
    if (!/^[a-z0-9][a-z0-9-]*-\d+$/.test(client.bucket) || !/^[a-z]{2}-[a-z0-9-]+$/.test(client.region) || typeof store.storeName !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(store.storeName)) throw storageError('ATOMIC_STORAGE_UNAVAILABLE');
    const credential = await client.resolveCredential();
    if (!credential?.secretId || !credential.secretKey || !credential.sessionToken) throw storageError('ATOMIC_STORAGE_UNAVAILABLE');
    const objectKey = client.buildCosKey(store.storeName, key);
    const payload = typeof value === 'string' ? Buffer.from(value, 'utf8') : value instanceof ArrayBuffer ? Buffer.from(value) : value instanceof Uint8Array ? Buffer.from(value) : null;
    if (!payload?.length) throw storageError('INVALID_VALUE');
    const query = { append: '', position: '0' };
    const headers = {
      'x-cos-security-token': credential.sessionToken,
      'content-length': String(payload.length),
      'content-md5': createHash('md5').update(payload).digest('base64'),
    };
    if (options.cacheControl !== null) headers['cache-control'] = options.cacheControl ?? 'no-store';
    if (contentType) headers['content-type'] = contentType;
    headers.authorization = signCosRequest('POST', objectKey, headers, credential, query);
    const url = `https://${client.bucket}.cos.${client.region}.myqcloud.com/${objectKey.split('/').map(encode).join('/')}?append&position=0`;
    let response;
    try { response = await send(url, { method: 'POST', headers, body: payload, signal: AbortSignal.timeout(10000) }); }
    catch { throw storageError('ATOMIC_STORAGE_CONNECTION_FAILED'); }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 409 && /<Code>\s*(PositionNotEqualToLength|ObjectNotAppendable)\s*<\/Code>/.test(detail)) throw storageError('PRECONDITION_FAILED');
      throw storageError(`ATOMIC_STORAGE_HTTP_${response.status}`);
    }
    await response.arrayBuffer().catch(() => {});
  }
  return {
    get: store.get.bind(store),
    list: store.list.bind(store),
    set(key, value, options = {}) {
      return options.onlyIfNew ? createOnly(key, value, options) : store.set(key, value, options);
    },
    setJSON(key, value, options = {}) {
      return options.onlyIfNew ? createOnly(key, JSON.stringify(value), options, 'application/json') : store.setJSON(key, value, options);
    },
  };
}
