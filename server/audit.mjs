import { auditCutoff } from './audit-retention.mjs';
import { randomUUID } from 'node:crypto';
import { hash } from './database.mjs';

import { AUDIT_ACTIONS } from './audit-actions.mjs';
import { auditCursor, auditMatches, publicAudit, indexAudit } from './audit-index.mjs';
export { AUDIT_ACTIONS } from './audit-actions.mjs';
const legacyPrefixes = ['private/audit/', 'recipes/', 'private/permissions/', 'private/permission-requests/', 'private/password-changes/', 'private/password-recovery-requests/', 'private/deleted-users/', 'private/password-recovery-decisions/', 'private/photo-optimizations/'];
const migrationKey = 'private/audit-migration/v1.json';
export class AuditLog {
  constructor(store) { this.store = store; this.index = entry => store.indexAudit ? store.indexAudit(entry) : indexAudit(store, entry); }
  entry(user, action, { target = '', result = 'success', operationId, code = '' } = {}) {
    if (!Object.hasOwn(AUDIT_ACTIONS, action)) return;
    const id = hash(`${user?.id || 'anonymous'}:${action}:${operationId || randomUUID()}:${result}`);
    return { id, createdAt: new Date().toISOString(), userId: user?.id || null, displayName: String(user?.displayName || '未登录用户').slice(0, 64), action, target: String(target).slice(0, 160), result, code };
  }
  async record(user, action, options = {}) {
    const entry = this.entry(user, action, options); if (!entry) return;
    const { id } = entry;
    const key = `private/audit/${id}.json`;
    if (options.operationId && await this.store.get(key, { type: 'json', consistency: 'strong' })) return;
    await this.store.setJSON(key, entry, { cacheControl: 'no-store' });
    if (this.store.queryAudit && !this.store.indexAudit) await this.index(entry);
  }
  async prepare() {
    if (!this.store.queryAudit) return { complete: true };
    const pending = await this.store.list({ prefix: 'private/audit-pending/', consistency: 'strong' });
    const repairing = Date.now(); let repaired = 0;
    while (repaired < Math.min(pending.blobs.length, 100) && Date.now() - repairing < 3000) {
      const batch = pending.blobs.slice(repaired, Math.min(repaired + 8, 100));
      await Promise.all(batch.map(async ({ key }) => {
        const entry = await this.store.get(key, { type: 'json', consistency: 'strong' });
        if (entry) await this.index(entry);
        await this.store.clearAuditPending(key);
      }));
      repaired += batch.length;
    }
    if (pending.blobs.length > repaired) return { complete: false, processed: repaired };
    const state = await this.store.get(migrationKey, { type: 'json', consistency: 'strong' }) || { prefix: 0, cursor: '', processed: 0, complete: false };
    if (state.complete) return state;
    const started = Date.now(); let budget = 100;
    while (state.prefix < legacyPrefixes.length && budget > 0 && Date.now() - started < 3000) {
      const prefix = legacyPrefixes[state.prefix];
      const { blobs } = await this.store.list({ prefix, consistency: 'strong' });
      const keys = blobs.map(item => item.key).filter(key => key > state.cursor).sort();
      const chosen = keys.slice(0, Math.min(8, budget));
      await Promise.all(chosen.map(async key => {
        const record = await this.store.get(key, { type: 'json', consistency: 'strong' });
        const entry = prefix === 'private/audit/' ? record : record?.auditEntry;
        if (entry) await this.index(entry);
      }));
      state.processed += chosen.length; budget -= chosen.length;
      if (keys.length <= chosen.length) { state.prefix++; state.cursor = ''; }
      else state.cursor = chosen.at(-1);
    }
    state.complete = state.prefix >= legacyPrefixes.length;
    await this.store.setJSON(migrationKey, state, { cacheControl: 'no-store' });
    return state;
  }
  async filtered({ query = '', result = '', from = '', to = '' } = {}) {
    from = from > auditCutoff() ? from : auditCutoff();
    if (this.store.queryAudit) {
      const progress = await this.prepare();
      if (!progress.complete) throw Object.assign(new Error('历史日志正在整理，请等待日志列表加载完成后再导出。'), { status: 503, code: 'AUDIT_INDEX_BUILDING' });
      const records = []; let cursor = '', bytes = 0;
      do {
        const batch = await this.store.queryAudit({ query, result, from, to, cursor, limit: 250 });
        for (const item of batch) {
          const entry = publicAudit(item); bytes += Buffer.byteLength(JSON.stringify(entry)); records.push(entry);
          if (records.length > 10000 || bytes > 4 * 1024 * 1024) throw Object.assign(new Error('日志较多，请缩小日期范围后分批导出（每次最多 10000 条）。'), { status: 413, code: 'AUDIT_EXPORT_TOO_LARGE' });
        }
        cursor = batch.length === 250 ? auditCursor(batch.at(-1)) : '';
      } while (cursor);
      return records;
    }
    const entries = new Map();
    for (const prefix of legacyPrefixes) {
      const { blobs } = await this.store.list({ prefix, consistency: 'strong' });
      const records = await Promise.all(blobs.map(({ key }) => this.store.get(key, { type: 'json', consistency: 'strong' })));
      for (const record of records) {
        const item = prefix === 'private/audit/' ? record : record?.auditEntry;
        if (item && !entries.has(item.id)) entries.set(item.id, item);
      }
    }
    return [...entries.values()]
      .filter(item => auditMatches({ ...item, searchText: `${item.displayName} ${item.userId} ${AUDIT_ACTIONS[item.action]} ${item.target}`.toLowerCase() }, { query, result, from, to }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async list({ cursor = '', query = '', result = '', from = '', to = '' } = {}) {
    from = from > auditCutoff() ? from : auditCutoff();
    if (this.store.queryAudit) {
      const progress = await this.prepare();
      if (!progress.complete) return { items: [], cursor: null, indexing: { processed: progress.processed } };
      const rows = await this.store.queryAudit({ cursor, query, result, from, to, limit: 51 });
      const items = rows.slice(0, 50).map(publicAudit);
      return { items, cursor: rows.length > 50 ? auditCursor(items.at(-1)) : null };
    }
    const all = await this.filtered({ query, result, from, to });
    const filtered = all.filter(item => !cursor || `${item.createdAt}|${item.id}` < cursor);
    const items = filtered.slice(0, 50);
    return { items, cursor: filtered.length > 50 ? `${items.at(-1).createdAt}|${items.at(-1).id}` : null };
  }
}
