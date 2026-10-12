import { randomUUID } from 'node:crypto';
import { isUserId } from './accounts.mjs';

const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export class Permissions {
  constructor(store, adminId) { this.store = store; this.adminId = adminId; }
  async events(userId) {
    if (!isUserId(userId)) throw problem(400, 'INVALID_ACCOUNT', '账号不存在。');
    const { blobs } = await this.store.list({ prefix: `private/permissions/${userId}/`, consistency: 'strong' });
    return (await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean);
  }
  async profile(user) {
    if (user.id === this.adminId) return { ...user, role: 'admin', canEdit: true };
    const events = await this.events(user.id);
    const generation = Math.max(0, ...events.map(event => event.generation));
    const heads = events.filter(event => event.generation === generation);
    // A concurrent revocation wins over a grant at the same generation.
    const canEdit = heads.length > 0 && heads.every(event => event.role === 'editor');
    return { ...user, role: canEdit ? 'editor' : 'viewer', canEdit };
  }
  async requests(userId) {
    const { blobs } = await this.store.list({ prefix: 'private/permission-requests/', consistency: 'strong' });
    const records = (await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })))).filter(item => item && (!userId || item.userId === userId));
    const byUser = new Map();
    for (const item of records) {
      if (!byUser.has(item.userId)) byUser.set(item.userId, await this.events(item.userId));
      const decisions = byUser.get(item.userId).filter(event => event.requestId === item.id).sort((a, b) => b.generation - a.generation || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const decision = decisions[0];
      item.status = decision ? (decision.action === 'approve' ? 'approved' : decision.action === 'reject' ? 'rejected' : 'revoked') : 'pending';
      if (decision) { item.reviewedAt = decision.createdAt; item.note = decision.note; }
      delete item.auditEntry;
    }
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async request(user, data, auditEntry) {
    if (user.role === 'admin' || user.canEdit) throw problem(409, 'ALREADY_AUTHORIZED', '你已经拥有编辑权限。');
    if (!uuid(data?.requestId) || typeof data.reason !== 'string' || data.reason.trim().length < 5 || data.reason.trim().length > 500) throw problem(400, 'INVALID_REASON', '请填写 5～500 字的申请原因。');
    const key = `private/permission-requests/${user.id}/${data.requestId}.json`;
    const existing = await this.store.get(key, { type: 'json', consistency: 'strong' });
    if (existing) {
      if (existing.reason !== data.reason.trim()) throw problem(409, 'REQUEST_CONFLICT', '此申请已提交，请刷新后重试。');
      return (await this.requests(user.id)).find(item => item.id === existing.id) || existing;
    }
    if ((await this.requests(user.id)).some(item => item.status === 'pending')) throw problem(409, 'REQUEST_PENDING', '已有申请等待管理员处理，请勿重复提交。');
    const item = { id: data.requestId, userId: user.id, displayName: user.displayName, reason: data.reason.trim(), createdAt: new Date().toISOString(), ...(auditEntry ? { auditEntry } : {}) };
    await this.store.setJSON(key, item, { cacheControl: 'no-store' });
    return { ...item, status: 'pending' };
  }
  async decide(admin, target, data, auditEntry) {
    if (admin.id !== this.adminId) throw problem(403, 'ADMIN_REQUIRED', '只有管理员可以管理账号授权。');
    if (target.id === this.adminId) throw problem(400, 'ADMIN_PROTECTED', '管理员权限不能变更。');
    if (!['approve', 'reject', 'revoke'].includes(data.action) || !uuid(data.mutationId) || (data.note !== undefined && (typeof data.note !== 'string' || data.note.trim().length > 500))) throw problem(400, 'INVALID_DECISION', '授权操作不完整，请刷新后重试。');
    const events = await this.events(target.id);
    const previous = events.find(event => event.id === data.mutationId);
    if (previous) {
      if (previous.action !== data.action || previous.requestId !== (data.requestId || null) || previous.note !== (data.note || '').trim()) throw problem(409, 'DECISION_CONFLICT', '同一次授权请求的内容发生变化，请刷新后重试。');
      return previous;
    }
    const requests = await this.requests(target.id);
    const request = requests.find(item => item.id === data.requestId);
    if (data.action !== 'revoke' && (!request || request.status !== 'pending')) throw problem(409, 'REQUEST_REVIEWED', '申请已被处理或不存在，请刷新授权页面。');
    const profile = await this.profile(target);
    if (data.action === 'revoke' && !profile.canEdit) throw problem(409, 'ALREADY_READ_ONLY', '该账号已经是查看权限。');
    const event = { id: data.mutationId, userId: target.id, reviewerId: admin.id, generation: Math.max(0, ...events.map(item => item.generation)) + 1, role: data.action === 'approve' || (data.action === 'reject' && profile.canEdit) ? 'editor' : 'viewer', action: data.action, requestId: data.requestId || null, note: (data.note || '').trim(), createdAt: new Date().toISOString() };
    if (auditEntry) event.auditEntry = auditEntry;
    await this.store.setJSON(`private/permissions/${target.id}/${String(event.generation).padStart(12, '0')}-${Date.now()}-${randomUUID()}.json`, event, { cacheControl: 'no-store' });
    return event;
  }
}
