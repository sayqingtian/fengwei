import { randomUUID } from 'node:crypto';
import { hash } from './database.mjs';

export const AUDIT_ACTIONS = {
  'account.register': '注册账号', 'account.login': '登录', 'account.logout': '退出登录',
  'account.password': '修改密码', 'audit.export': '导出操作日志',
  'recipes.sync': '同步菜谱', 'recipe.view': '查看菜谱', 'recipe.history': '查看历史版本',
  'recipe.create': '新增菜谱', 'recipe.update': '编辑菜谱', 'recipe.delete': '删除菜谱',
  'recipe.restore': '恢复历史版本', 'recipe.import': '导入菜谱', 'recipe.favorite': '收藏操作',
  'recipe.cook': '开始跟着做', 'backup.export': '导出备份',
  'permission.request': '申请编辑权限', 'permission.approve': '批准编辑权限',
  'permission.reject': '拒绝申请', 'permission.revoke': '撤销编辑权限',
};
export class AuditLog {
  constructor(store) { this.store = store; }
  entry(user, action, { target = '', result = 'success', operationId, code = '' } = {}) {
    if (!Object.hasOwn(AUDIT_ACTIONS, action)) return;
    const id = hash(`${user?.id || 'anonymous'}:${action}:${operationId || randomUUID()}:${result}`);
    return { id, createdAt: new Date().toISOString(), userId: user?.id || null, displayName: String(user?.displayName || '未登录用户').slice(0, 64), action, target: String(target).slice(0, 160), result, code };
  }
  async record(user, action, options = {}) {
    const entry = this.entry(user, action, options); if (!entry) return;
    const { id } = entry;
    const key = `private/audit/${id}.json`;
    if (await this.store.get(key, { type: 'json', consistency: 'strong' })) return;
    await this.store.setJSON(key, entry, { cacheControl: 'no-store' });
  }
  async filtered({ query = '', result = '' } = {}) {
    const entries = new Map();
    for (const prefix of ['private/audit/', 'recipes/', 'private/permissions/', 'private/permission-requests/', 'private/password-changes/']) {
      const { blobs } = await this.store.list({ prefix, consistency: 'strong' });
      const records = await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })));
      for (const record of records) {
        const item = prefix === 'private/audit/' ? record : record?.auditEntry;
        if (item && !entries.has(item.id)) entries.set(item.id, item);
      }
    }
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [...entries.values()]
      .filter(item => (!result || item.result === result) && terms.every(term => `${item.displayName} ${item.userId} ${AUDIT_ACTIONS[item.action]} ${item.target}`.toLowerCase().includes(term)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async list({ cursor = '', query = '', result = '' } = {}) {
    const all = await this.filtered({ query, result });
    const filtered = all.filter(item => !cursor || `${item.createdAt}|${item.id}` < cursor);
    const items = filtered.slice(0, 50);
    return { items, cursor: filtered.length > 50 ? `${items.at(-1).createdAt}|${items.at(-1).id}` : null };
  }
}
