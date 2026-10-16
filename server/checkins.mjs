import { hash } from './database.mjs';
import { isUserId } from './accounts.mjs';

const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const publicItem = ({ id, recipeId, title, note, cookedAt }) => ({ id, recipeId, title, note, cookedAt });
export class CookingCheckins {
  constructor(store) { this.store = store; }
  prefix(userId) {
    if (!isUserId(userId)) throw new Error('Invalid check-in account');
    return `private/cooking-checkins/${userId}/`;
  }
  validate(data) {
    if (!data || typeof data.recipeId !== 'string' || !data.recipeId || data.recipeId.length > 128 || /[\/\u0000-\u001f]/.test(data.recipeId) || typeof data.mutationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.mutationId) || (data.note !== undefined && (typeof data.note !== 'string' || data.note.length > 1000))) throw problem(400, 'INVALID_CHECKIN', '打卡内容不完整，心得最多 1000 字。');
    return { recipeId: data.recipeId, note: (data.note || '').trim(), id: data.mutationId };
  }
  async previous(userId, value) {
    const item = await this.store.get(`${this.prefix(userId)}${hash(value.id)}.json`, { type: 'json', consistency: 'strong' });
    if (!item) return null;
    if (item.recipeId !== value.recipeId || item.note !== value.note) throw problem(409, 'CHECKIN_CONFLICT', '这次打卡已提交，内容发生变化，请重新打开打卡窗口。');
    return publicItem(item);
  }
  async add(userId, value, title, auditEntry) {
    const item = { ...value, title, cookedAt: new Date().toISOString(), auditEntry };
    try { await this.store.setJSON(`${this.prefix(userId)}${hash(value.id)}.json`, item, { onlyIfNew: true, cacheControl: 'no-store' }); }
    catch (error) { if (error.code !== 'PRECONDITION_FAILED') throw error; return this.previous(userId, value); }
    return publicItem(item);
  }
  async list(userId, cursor = '') {
    if (cursor && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-f0-9-]{36}$/.test(cursor)) throw problem(400, 'INVALID_CURSOR', '打卡分页位置不正确。');
    const { blobs } = await this.store.list({ prefix: this.prefix(userId), consistency: 'strong' });
    const all = (await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean).map(publicItem).sort((a, b) => b.cookedAt.localeCompare(a.cookedAt) || b.id.localeCompare(a.id));
    const rest = all.filter(item => !cursor || `${item.cookedAt}|${item.id}` < cursor), items = rest.slice(0, 50);
    return { items, total: all.length, dishes: new Set(all.map(item => item.recipeId)).size, cursor: rest.length > 50 ? `${items.at(-1).cookedAt}|${items.at(-1).id}` : null };
  }
}
