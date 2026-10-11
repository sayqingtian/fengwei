import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { hash } from './database.mjs';

export const isUserId = value => typeof value === 'string' && /^usr_[a-f0-9]{32}$/.test(value);
const derive = (password, salt) => new Promise((resolve, reject) => scrypt(password, salt, 32, (error, value) => error ? reject(error) : resolve(value)));
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
export const publicUser = user => ({ id: user.id, loginId: user.id, displayName: user.displayName, createdAt: user.createdAt, legacy: !!user.legacy });

export class Accounts {
  constructor(store, legacy) {
    this.store = store; this.legacy = legacy;
    this.legacyId = `usr_${hash(`fengwei-original-user:${legacy?.username || 'wupanfeng'}`).slice(0, 32)}`;
  }
  key(id) { if (!isUserId(id)) throw new Error('Invalid account ID'); return `private/users/${id}.json`; }
  async get(id) { return isUserId(id) ? this.store.get(this.key(id), { type: 'json', consistency: 'strong' }) : null; }
  async original(create = true) {
    if (!this.legacy) return null;
    const existing = await this.get(this.legacyId); if (existing) return existing;
    const user = { id: this.legacyId, displayName: this.legacy.username, legacy: true, salt: this.legacy.salt, passwordHash: this.legacy.passwordHash, createdAt: new Date().toISOString() };
    if (create) await this.store.setJSON(this.key(user.id), user, { cacheControl: 'no-store' });
    return user;
  }
  async authenticate(identifier, password) {
    if (typeof identifier !== 'string' || typeof password !== 'string' || !password || password.length > 256) return null;
    identifier = identifier.trim().toLowerCase();
    const original = identifier === this.legacy?.username || identifier === this.legacyId;
    const user = original ? await this.original(false) : await this.get(identifier);
    // Use the same password derivation even for nonexistent IDs.
    const derived = await derive(password, user?.salt || this.legacy.salt);
    if (!user || !timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex'))) return null;
    return original ? this.original() : user;
  }
  async register(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw problem(400, 'INVALID_REGISTRATION', '注册请求不完整，请重新打开注册页面。');
    let { displayName, password, registrationId } = data;
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 30) throw problem(400, 'INVALID_DISPLAY_NAME', '昵称需要 1～30 个字符。');
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw problem(400, 'INVALID_PASSWORD', '密码需要 8～128 个字符。');
    if (typeof registrationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(registrationId)) throw problem(400, 'INVALID_REGISTRATION', '注册请求不完整，请重新打开注册页面。');
    displayName = displayName.trim();
    // A random registration nonce gives one stable, unique account ID. A
    // response lost in transit can be retried without creating another user.
    // Nicknames may repeat; never use a Blob read/write race to reserve names.
    const id = `usr_${hash(`fengwei-registration-v1:${registrationId}`).slice(0, 32)}`;
    const existing = await this.get(id);
    if (existing) {
      const derived = await derive(password, existing.salt);
      if (existing.displayName !== displayName || !timingSafeEqual(derived, Buffer.from(existing.passwordHash, 'hex'))) throw problem(409, 'REGISTRATION_CONFLICT', '此注册请求已使用，请重新打开注册页面。');
      return existing;
    }
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await derive(password, salt)).toString('hex');
    const user = { id, displayName, salt, passwordHash, createdAt: new Date().toISOString(), legacy: false };
    await this.store.setJSON(this.key(id), user, { cacheControl: 'no-store' });
    return user;
  }
}
