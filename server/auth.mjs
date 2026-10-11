import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DEFAULT_ACCOUNT } from './auth-config.mjs';
import { hash } from './database.mjs';
import { Accounts, publicUser, isUserId } from './accounts.mjs';

export const COOKIE = 'fengwei_session';
export const SESSION_SECONDS = 90 * 24 * 3600;
export const RENEW_WITHIN_SECONDS = 7 * 24 * 3600;
const safeEqual = (a, b) => timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));

// Test injection keeps synthetic test passwords out of production defaults.
export function testAccount(password) {
  if (typeof password !== 'string' || !password) return null;
  const salt = hash(`fengwei-test-fixture:${password}`).slice(0, 32);
  return { username: DEFAULT_ACCOUNT.username, salt, passwordHash: scryptSync(password, salt, 32).toString('hex') };
}
export function createAuth(store, account = DEFAULT_ACCOUNT) {
  const accounts = new Accounts(store, account);
  const fingerprint = account ? hash(JSON.stringify(account)) : '';
  const prefix = `private/auth/${fingerprint}/`;
  async function signingKey(create = false) {
    // No unsupported conditional-write lock: immutable candidates retain their
    // values, and the first canonical key is selected with a strongly read list.
    // Re-read each time rather than indefinitely caching a bootstrap race.
    let { blobs } = await store.list({ prefix, consistency: 'strong' });
    if (!blobs.length) {
      if (!create) return null;
      await store.setJSON(`${prefix}${Date.now()}-${randomUUID()}.json`, { key: randomBytes(32).toString('hex') }, { cacheControl: 'no-store' });
      ({ blobs } = await store.list({ prefix, consistency: 'strong' }));
    }
    const selected = blobs.map(item => item.key).filter(key => /^\d{13}-[a-f0-9-]{36}\.json$/.test(key.slice(prefix.length))).sort()[0];
    const record = selected && await store.get(selected, { type: 'json', consistency: 'strong' });
    if (!/^[a-f0-9]{64}$/.test(record?.key || '')) throw new Error('Session signing key is not available');
    return { key: record.key, keyId: selected.slice(prefix.length) };
  }
  const sign = (value, key, version = 3) => createHmac('sha256', key).update(`fengwei-session-v${version}:${value}`).digest('base64url');
  return {
    accounts,
    get configured() { return !!account && /^[a-f0-9]{64}$/.test(account.passwordHash); },
    async check(username, password) { return !!await accounts.authenticate(username, password); },
    async issue(userOrNow, suppliedNow) {
      const now = typeof userOrNow === 'number' ? userOrNow : suppliedNow ?? Date.now();
      const user = userOrNow && typeof userOrNow === 'object' ? userOrNow : await accounts.original();
      const record = await signingKey(true);
      const payload = Buffer.from(JSON.stringify({ version: 3, userId: user.id, keyId: record.keyId, exp: Math.floor(now / 1000) + SESSION_SECONDS, nonce: randomBytes(16).toString('hex') })).toString('base64url');
      return `${payload}.${sign(payload, record.key)}`;
    },
    async verify(request, now = Date.now()) {
      const value = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
      if (!value || value.length > 1024) return null;
      const parts = value.split('.');
      if (parts.length !== 2) return null;
      let payload;
      try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return null; }
      if (![2, 3].includes(payload.version) || !Number.isFinite(payload.exp) || payload.exp <= now / 1000) return null;
      if (payload.version === 2 && payload.username !== account.username) return null;
      if (payload.version === 3 && !isUserId(payload.userId)) return null;
      if (!/^\d{13}-[a-f0-9-]{36}\.json$/.test(payload.keyId || '')) return null;
      // Reference the exact immutable key used to issue this token. Even if
      // concurrent first logins create different keys, both sessions stay valid.
      const record = await store.get(`${prefix}${payload.keyId}`, { type: 'json', consistency: 'strong' });
      if (!/^[a-f0-9]{64}$/.test(record?.key || '')) return null;
      const expected = sign(parts[0], record.key, payload.version);
      if (!safeEqual(expected, parts[1])) return null;
      const user = payload.version === 2 ? await accounts.original() : await accounts.get(payload.userId);
      if (!user) return null;
      return { user: publicUser(user), renew: payload.version === 2 || payload.exp - now / 1000 < RENEW_WITHIN_SECONDS };
    },
  };
}
export function sessionCookie(request, value, maxAge = SESSION_SECONDS) {
  return `${COOKIE}=${value}; Path=/api/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
