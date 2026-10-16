import { hash } from './database.mjs';
import { isUserId } from './accounts.mjs';

const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const publicItem = ({ id, recipeId, title, note, cookedAt }) => ({ id, recipeId, title, note, cookedAt });
const validId = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
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
    if (await this.store.get(this.deletionKey(userId, value.id), { type: 'json', consistency: 'strong' })) throw problem(410, 'CHECKIN_DELETED', '这条打卡已经删除。');
    const item = await this.store.get(`${this.prefix(userId)}${hash(value.id)}.json`, { type: 'json', consistency: 'strong' });
    if (!item) return null;
    if (item.recipeId !== value.recipeId || item.note !== value.note) throw problem(409, 'CHECKIN_CONFLICT', '这次打卡已提交，内容发生变化，请重新打开打卡窗口。');
    return publicItem(item);
  }
  async add(userId, value, title, auditEntry) {
    const item = { ...value, title, cookedAt: new Date().toISOString(), auditEntry };
    try { await this.store.setJSON(`${this.prefix(userId)}${hash(value.id)}.json`, item, { onlyIfNew: true, cacheControl: 'no-store' }); }
    catch (error) { if (error.code !== 'PRECONDITION_FAILED') throw error; return this.previous(userId, value); }
    if (await this.store.get(this.deletionKey(userId, value.id), { type: 'json', consistency: 'strong' })) {
      await this.store.delete(`${this.prefix(userId)}${hash(value.id)}.json`);
      throw problem(410, 'CHECKIN_DELETED', '这条打卡已经删除。');
    }
    return publicItem(item);
  }
  deletionKey(userId, id) {
    if (!validId(id)) throw problem(400, 'INVALID_CHECKIN', '打卡编号不正确。');
    this.prefix(userId);
    return `private/cooking-checkin-deletions/${userId}/${hash(id)}.json`;
  }
  async remove(userId, id, auditEntry) {
    const tombstone = this.deletionKey(userId, id), key = `${this.prefix(userId)}${hash(id)}.json`;
    const [deleted, item] = await Promise.all([this.store.get(tombstone, { type: 'json', consistency: 'strong' }), this.store.get(key, { type: 'json', consistency: 'strong' })]);
    if (!deleted && !item) throw problem(404, 'NOT_FOUND', '这条打卡不存在。');
    if (!deleted) {
      try { await this.store.setJSON(tombstone, { id, deletedAt: new Date().toISOString(), auditEntry }, { onlyIfNew: true, cacheControl: 'no-store' }); }
      catch (error) { if (error.code !== 'PRECONDITION_FAILED') throw error; }
    }
    await this.store.delete(key);
    return { id, deleted: true };
  }
  async list(userId, cursor = '') {
    if (cursor && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\|[a-f0-9-]{36}$/.test(cursor)) throw problem(400, 'INVALID_CURSOR', '打卡分页位置不正确。');
    const [{ blobs }, deletions] = await Promise.all([this.store.list({ prefix: this.prefix(userId), consistency: 'strong' }), this.store.list({ prefix: `private/cooking-checkin-deletions/${userId}/`, consistency: 'strong' })]);
    const removed = new Set(deletions.blobs.map(({ key }) => key.split('/').at(-1)));
    const all = (await Promise.all(blobs.filter(({ key }) => !removed.has(key.split('/').at(-1))).map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })))).filter(Boolean).map(publicItem).sort((a, b) => b.cookedAt.localeCompare(a.cookedAt) || b.id.localeCompare(a.id));
    const rest = all.filter(item => !cursor || `${item.cookedAt}|${item.id}` < cursor), items = rest.slice(0, 50);
    return { items, total: all.length, dishes: new Set(all.map(item => item.recipeId)).size, cursor: rest.length > 50 ? `${items.at(-1).cookedAt}|${items.at(-1).id}` : null };
  }
}
