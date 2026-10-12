import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { isUserId, normalizeUsername, requireUniqueWrites } from './accounts.mjs';

const prefix = 'private/password-recovery-requests/';
const decisionPrefix = 'private/password-recovery-decisions/';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const derive = (value, salt) => new Promise((resolve, reject) => scrypt(value, salt, 32, (error, key) => error ? reject(error) : resolve(key)));
const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
export const RECOVERY_MESSAGE = '申请已受理。如账号信息匹配，管理员会核实身份，并通过线下方式告知新密码。';
const lifetime = 7 * 24 * 3600000;

export class PasswordRecovery {
  constructor(accounts, adminId) { this.accounts = accounts; this.store = accounts.store; this.adminId = adminId; }
  key(userId, requestId, base = prefix) {
    if (!isUserId(userId) || !uuid(requestId)) throw problem(400, 'INVALID_RECOVERY', '找回申请信息不完整，请刷新后重试。');
    return `${base}${userId}/${requestId}.json`;
  }
  async account(identifier) {
    const name = normalizeUsername(identifier);
    if (name === normalizeUsername(this.accounts.legacy?.username || '') || name === this.accounts.legacyId) return this.accounts.original(false);
    if (isUserId(name)) return this.accounts.get(name);
    const matches = await this.accounts.named(name);
    return matches.length === 1 ? this.accounts.get(matches[0].id) : null;
  }
  async request(data, auditEntry) {
    if (!uuid(data?.requestId) || typeof data.username !== 'string' || !data.username.trim() || data.username.length > 64 || typeof data.contact !== 'string' || data.contact.trim().length < 2 || data.contact.trim().length > 100 || (data.reason !== undefined && (typeof data.reason !== 'string' || data.reason.trim().length > 500))) throw problem(400, 'INVALID_RECOVERY', '请填写账号和线下联系方式（2～100 字），备注最多 500 字。');
    await requireUniqueWrites(this.store);
    const user = await this.account(data.username);
    // Never disclose account existence or change credentials at submission time.
    if (!user) return;
    const key = this.key(user.id, data.requestId);
    if (await this.store.get(key, { type: 'json', consistency: 'strong' })) return;
    if ((await this.requests(user.id, false)).some(item => ['pending', 'processing'].includes(item.status))) return;
    // The database, rather than an instance-local lock, bounds repeated requests.
    const slot = await this.accounts.reserve(`private/password-recovery-limits/${user.id}/${Math.floor(Date.now() / 600000)}.json`, { requestId: data.requestId });
    if (slot?.requestId !== data.requestId) return;
    const item = { id: data.requestId, userId: user.id, displayName: user.displayName, contact: data.contact.trim(), reason: (data.reason || '').trim(), passwordVersion: user.passwordVersion || 'initial', createdAt: new Date().toISOString(), ...(auditEntry ? { auditEntry } : {}) };
    await this.accounts.reserve(key, item);
  }
  async applyReset(item, decision) {
    let user = await this.accounts.get(item.userId);
    if (!user && item.userId === this.accounts.legacyId) user = await this.accounts.original();
    if (!user) return false;
    const key = this.accounts.passwordKey(item.userId, item.passwordVersion);
    const previous = await this.store.get(key, { type: 'json', consistency: 'strong' });
    if (previous) return previous.version === decision.id && previous.recoveryRequestId === item.id;
    if (user.passwordVersion !== item.passwordVersion) return false;
    const change = { userId: item.userId, parentVersion: item.passwordVersion, version: decision.id, salt: decision.salt, passwordHash: decision.passwordHash, requestHash: decision.requestHash, changedAt: decision.createdAt, recoveryRequestId: item.id, reviewerId: decision.reviewerId, ...(decision.auditEntry ? { auditEntry: decision.auditEntry } : {}) };
    const saved = await this.accounts.reserve(key, change);
    if (saved?.version !== change.version || saved.recoveryRequestId !== item.id) return false;
    // The immutable revision is authoritative even if updating this cache fails.
    try { await this.store.setJSON(`private/password-heads/${item.userId}.json`, { parentVersion: change.parentVersion }, { cacheControl: 'no-store' }); }
    catch (error) { console.error('Fengwei recovery password head unavailable:', error.code || error.name); }
    return true;
  }
  async view(item, apply = false) {
    const decision = await this.store.get(this.key(item.userId, item.id, decisionPrefix), { type: 'json', consistency: 'strong' });
    let status;
    if (decision?.action === 'reject') status = 'rejected';
    else if (decision?.action === 'reset' && apply) status = await this.applyReset(item, decision) ? 'reset' : 'stale';
    else {
      const user = await this.account(item.userId);
      const revision = decision && await this.store.get(this.accounts.passwordKey(item.userId, item.passwordVersion), { type: 'json', consistency: 'strong' });
      if (decision && revision?.version === decision.id) status = 'reset';
      else if (!user || user.passwordVersion !== item.passwordVersion) status = 'stale';
      else if (Date.now() - Date.parse(item.createdAt) > lifetime) status = 'expired';
      else status = decision ? 'processing' : 'pending';
    }
    return { id: item.id, userId: item.userId, displayName: item.displayName, contact: item.contact, reason: item.reason, createdAt: item.createdAt, status, ...(decision ? { reviewedAt: decision.createdAt, note: decision.note, reviewerId: decision.reviewerId } : {}) };
  }
  async requests(userId, apply = true) {
    const { blobs } = await this.store.list({ prefix: userId ? `${prefix}${userId}/` : prefix, consistency: 'strong' });
    const items = (await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean);
    return (await Promise.all(items.map(item => this.view(item, apply)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async decide(admin, data, auditEntry) {
    if (admin.id !== this.adminId) throw problem(403, 'ADMIN_REQUIRED', '只有管理员可以处理密码找回申请。');
    if (!['reset', 'reject'].includes(data?.action) || !uuid(data.mutationId) || (data.note !== undefined && (typeof data.note !== 'string' || data.note.trim().length > 500))) throw problem(400, 'INVALID_RECOVERY_DECISION', '处理信息不完整，请刷新后重试。');
    if (data.action === 'reset') {
      if (data.identityVerified !== true) throw problem(400, 'IDENTITY_CHECK_REQUIRED', '请先通过已有的线下联系渠道核实账号主人身份。');
      if (typeof data.newPassword !== 'string' || data.newPassword.length < 8 || data.newPassword.length > 128 || !data.newPassword.trim()) throw problem(400, 'INVALID_PASSWORD', '新密码需要 8～128 个字符，不能全为空格。');
      if (data.confirmPassword !== data.newPassword) throw problem(400, 'PASSWORD_MISMATCH', '两次输入的新密码不一致。');
    }
    const item = await this.store.get(this.key(data.userId, data.requestId), { type: 'json', consistency: 'strong' });
    if (!item) throw problem(404, 'RECOVERY_NOT_FOUND', '找回申请不存在。');
    const decisionKey = this.key(item.userId, item.id, decisionPrefix);
    let decision = await this.store.get(decisionKey, { type: 'json', consistency: 'strong' });
    if (!decision) {
      if ((await this.view(item)).status !== 'pending') throw problem(409, 'RECOVERY_STALE', '申请已失效，账号密码可能已变更，请刷新列表。');
      await requireUniqueWrites(this.store);
      const candidate = { id: data.mutationId, requestId: item.id, userId: item.userId, reviewerId: admin.id, action: data.action, note: (data.note || '').trim(), createdAt: new Date().toISOString(), ...(auditEntry ? { auditEntry } : {}) };
      if (data.action === 'reset') {
        const user = await this.account(item.userId);
        const { blobs } = await this.store.list({ prefix: `private/password-changes/${item.userId}/`, consistency: 'strong' });
        const history = await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })));
        if (history.some(change => change?.version === data.mutationId)) throw problem(409, 'RECOVERY_CONFLICT', '此重置请求编号已使用，请重新打开处理窗口。');
        if (timingSafeEqual(await derive(data.newPassword, user.salt), Buffer.from(user.passwordHash, 'hex'))) throw problem(400, 'PASSWORD_UNCHANGED', '新密码不能与当前密码相同。');
        candidate.salt = randomBytes(16).toString('hex');
        candidate.passwordHash = (await derive(data.newPassword, candidate.salt)).toString('hex');
        candidate.requestHash = (await derive(`fengwei-password-recovery-v1:${data.newPassword}`, candidate.salt)).toString('hex');
      }
      // One immutable decision selects reset OR rejection across cloud instances.
      // A reset command contains only hashes, and can finish after a lost reply.
      decision = await this.accounts.reserve(decisionKey, candidate);
    }
    if (decision.id !== data.mutationId || decision.action !== data.action || decision.reviewerId !== admin.id || decision.note !== (data.note || '').trim()) throw problem(409, 'RECOVERY_REVIEWED', '申请已被处理，请刷新列表。');
    if (decision.action === 'reset' && !timingSafeEqual(await derive(data.newPassword, decision.salt), Buffer.from(decision.passwordHash, 'hex'))) throw problem(409, 'RECOVERY_CONFLICT', '同一次重置请求的密码发生变化，请刷新列表。');
    const result = await this.view(item, true);
    if (result.status === 'stale') throw problem(409, 'RECOVERY_STALE', '账号密码已变更，本次重置未生效，请刷新列表。');
    return result;
  }
}
