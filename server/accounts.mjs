import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { hash } from './database.mjs';

export const isUserId = value => typeof value === 'string' && /^usr_[a-f0-9]{32}$/.test(value);
const derive = (password, salt) => new Promise((resolve, reject) => scrypt(password, salt, 32, (error, value) => error ? reject(error) : resolve(value)));
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const uniqueWriteChecks = new WeakMap();
export async function requireUniqueWrites(store) {
  if (!uniqueWriteChecks.has(store)) uniqueWriteChecks.set(store, (async () => {
    // A fresh probe avoids importing failed capability checks from Blob.
    const key = 'private/registration-storage-check-v3.json';
    try { await store.setJSON(key, { marker: 'protected' }, { onlyIfNew: true, cacheControl: 'no-store' }); }
    catch (error) { if (error.code !== 'PRECONDITION_FAILED') throw error; }
    try { await store.setJSON(key, { marker: 'conditional-write-unsupported' }, { onlyIfNew: true, cacheControl: 'no-store' }); }
    catch (error) {
      if (error.code !== 'PRECONDITION_FAILED') throw error;
      // Verify the account reader sees the unchanged, durable record.
      const probe = await store.get(key, { type: 'json', consistency: 'strong' });
      if (probe?.marker === 'protected') return;
      throw problem(503, 'UNIQUE_STORAGE_UNAVAILABLE', '注册暂时不可用，请稍后重试或联系管理员。');
    }
    throw problem(503, 'UNIQUE_STORAGE_UNAVAILABLE', '注册暂时不可用，请稍后重试或联系管理员。');
  })());
  try { await uniqueWriteChecks.get(store); }
  catch (error) { uniqueWriteChecks.delete(store); throw error; }
}
export const normalizeUsername = value => value.normalize('NFKC').trim().toLowerCase();
export const publicUser = user => ({ id: user.id, loginId: user.id, displayName: user.displayName, createdAt: user.createdAt, legacy: !!user.legacy, role: user.role || 'viewer', canEdit: !!user.canEdit, ...(user.passwordChangedAt ? { passwordChangedAt: user.passwordChangedAt } : {}) });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export class Accounts {
  constructor(store, legacy) {
    this.store = store; this.legacy = legacy;
    this.legacyId = `usr_${hash(`fengwei-original-user:${legacy?.username || 'wupanfeng'}`).slice(0, 32)}`;
  }
  key(id) { if (!isUserId(id)) throw new Error('Invalid account ID'); return `private/users/${id}.json`; }
  nameKey(name) { return `private/usernames/${hash(normalizeUsername(name))}.json`; }
  passwordKey(id, version) {
    if (!isUserId(id) || (version !== 'initial' && !uuid(version))) throw new Error('Invalid password revision');
    return `private/password-changes/${id}/${version}.json`;
  }
  async withPassword(user, snapshot) {
    if (!user) return null;
    snapshot ??= this.store.accountSnapshot ? await this.store.accountSnapshot(user.id) : null;
    const read = key => snapshot ? snapshot.get(key) || null : this.store.get(key, { type: 'json', consistency: 'strong' });
    let state = { ...user, passwordVersion: 'initial' };
    const head = await read(`private/password-heads/${user.id}.json`);
    let record = head ? await read(this.passwordKey(user.id, head.parentVersion)) : null;
    if (head && !record) throw new Error('Password revision is not available');
    const seen = new Set();
    while (true) {
      const parent = state.passwordVersion;
      record ||= await read(this.passwordKey(user.id, parent));
      if (!record) return state;
      const expectedParent = head && seen.size === 0 ? head.parentVersion : parent;
      if (record.userId !== user.id || record.parentVersion !== expectedParent || !uuid(record.version) || !/^[a-f0-9]{32}$/.test(record.salt) || !/^[a-f0-9]{64}$/.test(record.passwordHash) || !/^[a-f0-9]{64}$/.test(record.requestHash) || seen.has(record.version)) throw new Error('Invalid password revision');
      seen.add(record.version);
      state = { ...user, salt: record.salt, passwordHash: record.passwordHash, passwordVersion: record.version, passwordRequestHash: record.requestHash, passwordChangedAt: record.changedAt };
      record = null;
    }
  }
  async get(id) {
    if (!isUserId(id)) return null;
    const snapshot = this.store.accountSnapshot ? await this.store.accountSnapshot(id) : null;
    const read = key => snapshot ? snapshot.get(key) || null : this.store.get(key, { type: 'json', consistency: 'strong' });
    const stored = await read(this.key(id));
    if (stored) return this.withPassword(stored, snapshot);
    const pending = await read(`private/registrations/${id}.json`);
    const claim = pending && await this.store.get(this.nameKey(pending.displayName), { type: 'json', consistency: 'strong' });
    return claim?.id === id ? this.withPassword(pending, snapshot) : null;
  }
  async list() {
    const { blobs } = await this.store.list({ prefix: 'private/users/', consistency: 'strong' });
    const users = (await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean);
    const { blobs: names } = await this.store.list({ prefix: 'private/usernames/', consistency: 'strong' });
    for (const { key } of names) {
      const claim = await this.store.get(key, { type: 'json', consistency: 'strong' });
      if (claim && !users.some(user => user.id === claim.id)) { const user = await this.get(claim.id); if (user) users.push(user); }
    }
    if (this.legacy && !users.some(user => user.id === this.legacyId)) users.push(await this.original(false));
    return users;
  }
  async named(name) {
    const claim = await this.store.get(this.nameKey(name), { type: 'json', consistency: 'strong' });
    if (claim) {
      const user = await this.get(claim.id);
      return user && normalizeUsername(user.displayName) === normalizeUsername(name) ? [user] : [];
    }
    // Older accounts without a username reservation retain ID/name compatibility.
    return (await this.list()).filter(user => normalizeUsername(user.displayName) === normalizeUsername(name));
  }
  async reserve(key, value) {
    // No read/write lock or fallback: storage must enforce create-only writes.
    try { await this.store.setJSON(key, value, { cacheControl: 'no-store', onlyIfNew: true }); return value; }
    catch (error) {
      if (error.code !== 'PRECONDITION_FAILED') throw error;
      return this.store.get(key, { type: 'json', consistency: 'strong' });
    }
  }
  async original(create = true) {
    if (!this.legacy) return null;
    const existing = await this.get(this.legacyId); if (existing) return existing;
    const user = { id: this.legacyId, displayName: this.legacy.username, legacy: true, salt: this.legacy.salt, passwordHash: this.legacy.passwordHash, createdAt: new Date().toISOString() };
    if (create) await this.store.setJSON(this.key(user.id), user, { cacheControl: 'no-store' });
    return this.withPassword(user);
  }
  async authenticate(identifier, password) {
    if (typeof identifier !== 'string' || typeof password !== 'string' || !password || password.length > 256) return null;
    identifier = normalizeUsername(identifier);
    const original = identifier === this.legacy?.username || identifier === this.legacyId;
    const matches = !original && !isUserId(identifier) ? await this.named(identifier) : [];
    const user = original ? await this.original(false) : isUserId(identifier) ? await this.get(identifier) : matches.length === 1 ? await this.get(matches[0].id) : null;
    // Use the same password derivation even for nonexistent IDs.
    const derived = await derive(password, user?.salt || this.legacy.salt);
    if (!user || !timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex'))) return null;
    if (original) await this.original();
    return user;
  }
  async changePassword(id, data, expectedVersion = 'initial', auditEntry) {
    if (!data || typeof data.currentPassword !== 'string' || !data.currentPassword || data.currentPassword.length > 256 || !uuid(data.mutationId)) throw problem(400, 'INVALID_PASSWORD_CHANGE', '请完整填写当前密码和新密码。');
    if (typeof data.newPassword !== 'string' || data.newPassword.length < 8 || data.newPassword.length > 128 || !data.newPassword.trim()) throw problem(400, 'INVALID_PASSWORD', '新密码需要 8～128 个字符，不能全为空格。');
    if (data.confirmPassword !== data.newPassword) throw problem(400, 'PASSWORD_MISMATCH', '两次输入的新密码不一致，请重新确认。');
    if (data.currentPassword === data.newPassword) throw problem(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同。');
    let user = await this.get(id);
    if (!user) throw problem(404, 'ACCOUNT_NOT_FOUND', '账号不存在。');
    // An identical retry using the newly issued cookie can safely confirm the
    // completed operation without resetting the password or reviving a session.
    if (user.passwordVersion === data.mutationId) {
      const proof = await derive(`fengwei-password-change-v1:${JSON.stringify([data.currentPassword, data.newPassword])}`, user.salt);
      if (!timingSafeEqual(proof, Buffer.from(user.passwordRequestHash, 'hex'))) throw problem(409, 'PASSWORD_CHANGE_CONFLICT', '同一次修改请求的内容发生变化，请重新打开修改密码页面。');
      return user;
    }
    if (user.passwordVersion !== expectedVersion) throw problem(409, 'PASSWORD_CHANGE_CONFLICT', '密码已在其他设备修改，请重新登录后再试。');
    const derived = await derive(data.currentPassword, user.salt);
    if (!timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex'))) throw problem(400, 'CURRENT_PASSWORD_INCORRECT', '当前密码不正确，请重新输入。');
    const { blobs } = await this.store.list({ prefix: `private/password-changes/${id}/`, consistency: 'strong' });
    const history = await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })));
    if (history.some(item => item?.version === data.mutationId)) throw problem(409, 'PASSWORD_CHANGE_CONFLICT', '此修改请求已使用，请重新打开修改密码页面。');
    try { await requireUniqueWrites(this.store); }
    catch (error) {
      if (error.code === 'UNIQUE_STORAGE_UNAVAILABLE') throw problem(503, 'PASSWORD_STORAGE_UNAVAILABLE', '修改密码暂时不可用，请稍后重试或联系管理员。');
      throw error;
    }
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await derive(data.newPassword, salt)).toString('hex');
    const requestHash = (await derive(`fengwei-password-change-v1:${JSON.stringify([data.currentPassword, data.newPassword])}`, salt)).toString('hex');
    const change = { userId: id, parentVersion: user.passwordVersion, version: data.mutationId, salt, passwordHash, requestHash, changedAt: new Date().toISOString(), ...(auditEntry ? { auditEntry } : {}) };
    // One immutable successor per password revision: parallel changes cannot
    // both succeed, and a stale head cache can follow the chain to the new one.
    const saved = await this.reserve(this.passwordKey(id, user.passwordVersion), change);
    if (saved?.version !== change.version) throw problem(409, 'PASSWORD_CHANGE_CONFLICT', '密码已在其他设备修改，请重新登录后再试。');
    const savedPassword = await derive(data.newPassword, saved.salt);
    if (!timingSafeEqual(savedPassword, Buffer.from(saved.passwordHash, 'hex'))) throw problem(409, 'PASSWORD_CHANGE_CONFLICT', '同一次修改请求的内容发生变化，请重新打开修改密码页面。');
    try { await this.store.setJSON(`private/password-heads/${id}.json`, { parentVersion: change.parentVersion }, { cacheControl: 'no-store' }); }
    catch (error) { console.error('Fengwei password head cache unavailable:', error.code || error.name); }
    user = await this.get(id);
    if (user.passwordVersion !== change.version) throw problem(409, 'PASSWORD_CHANGE_CONFLICT', '密码已在其他设备再次修改，请使用最新密码重新登录。');
    return user;
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
    // Existing nonce-derived IDs and old sessions remain compatible.
    const id = `usr_${hash(`fengwei-registration-v1:${registrationId}`).slice(0, 32)}`;
    const existing = await this.get(id);
    if (existing) {
      const derived = await derive(password, existing.salt);
      if (normalizeUsername(existing.displayName) !== normalizeUsername(displayName) || !timingSafeEqual(derived, Buffer.from(existing.passwordHash, 'hex'))) throw problem(409, 'REGISTRATION_CONFLICT', '此注册请求已使用，请重新打开注册页面。');
      return existing;
    }
    const name = normalizeUsername(displayName);
    if (name === normalizeUsername(this.legacy?.username || 'wupanfeng') || isUserId(name)) throw problem(409, 'USERNAME_TAKEN', '这个用户名已被注册，请使用其他用户名。');
    if (/[\u0000-\u001f\u007f]/u.test(displayName)) throw problem(400, 'INVALID_DISPLAY_NAME', '用户名不能包含控制字符。');
    if ((await this.named(name)).length) throw problem(409, 'USERNAME_TAKEN', '这个用户名已被注册，请使用其他用户名。');
    await requireUniqueWrites(this.store);
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await derive(password, salt)).toString('hex');
    const candidate = { id, displayName, registrationId, salt, passwordHash, createdAt: new Date().toISOString(), legacy: false };
    const user = await this.reserve(`private/registrations/${id}.json`, candidate);
    const derived = await derive(password, user.salt);
    if (normalizeUsername(user.displayName) !== name || !timingSafeEqual(derived, Buffer.from(user.passwordHash, 'hex'))) throw problem(409, 'REGISTRATION_CONFLICT', '此注册请求已使用，请重新打开注册页面。');
    const claim = await this.reserve(this.nameKey(name), { id: user.id });
    if (claim?.id !== user.id) throw problem(409, 'USERNAME_TAKEN', '这个用户名已被注册，请使用其他用户名。');
    await this.store.setJSON(this.key(id), user, { cacheControl: 'no-store' });
    return user;
  }
}
