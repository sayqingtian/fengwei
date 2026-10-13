export const AUDIT_RETENTION_DAYS = 7;
export const auditCutoff = (now = Date.now()) => new Date(now - AUDIT_RETENTION_DAYS * 86400000).toISOString();
export const auditExpired = (entry, cutoff = auditCutoff()) => !entry || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) || entry.createdAt < cutoff;
export const auditObjects = ['private/audit/', 'private/audit-index/', 'private/audit-canonical/', 'private/audit-pending/'];
export const receiptObjects = ['recipes/', 'private/permissions/', 'private/permission-requests/', 'private/password-changes/', 'private/password-recovery-requests/', 'private/password-recovery-decisions/', 'private/deleted-users/', 'private/photo-optimizations/'];
export const isAuditObject = key => auditObjects.some(prefix => key.startsWith(prefix));
export const canPruneAudit = key => isAuditObject(key) || receiptObjects.some(prefix => key.startsWith(prefix));
export function retainedRecord(key, value, cutoff = auditCutoff()) {
  if (isAuditObject(key)) return auditExpired(value, cutoff) ? null : value;
  if (value?.auditEntry && auditExpired(value.auditEntry, cutoff)) { const { auditEntry, ...rest } = value; return rest; }
  return value;
}
// Persist a cursor so a large historical backlog is processed in bounded batches.
// The receipt is removed; recipe/password/permission history itself is preserved.
const stateKey = 'private/audit-retention/v1.json';
const running = new WeakMap();
export class AuditRetention {
  constructor(store) { this.store = store; }
  async status() {
    const state = await this.store.get(stateKey, { type: 'json', consistency: 'strong' }) || {};
    return { retentionDays: 7, complete: !!state.completedAt, processed: state.processed || 0,
      stagesDone: Math.min(state.prefix || 0, auditObjects.length + receiptObjects.length), stagesTotal: auditObjects.length + receiptObjects.length,
      startedAt: state.startedAt || null, lastAttemptAt: state.lastAttemptAt || null,
      lastCompletedAt: state.lastCompletedAt || state.completedAt || null,
      failedAt: state.failedAt || null, error: state.error || null };
  }
  run(options = {}) {
    if (running.has(this.store)) return running.get(this.store);
    const job = this.batch(options).finally(() => { if (running.get(this.store) === job) running.delete(this.store); });
    running.set(this.store, job); return job;
  }
  async batch({ maxRecords = 120, budgetMs = 2000, now = Date.now() } = {}) {
    let state = await this.store.get(stateKey, { type: 'json', consistency: 'strong' }) || {};
    if (state.completedAt && now - Date.parse(state.completedAt) < 3600000) return { ...state, complete: true };
    const timestamp = new Date(now).toISOString();
    if (state.completedAt || !state.startedAt) state = { prefix: 0, cursor: '', processed: 0, startedAt: timestamp, cutoff: auditCutoff(now), lastCompletedAt: state.completedAt || state.lastCompletedAt || null };
    state.lastAttemptAt = timestamp;
    const prefixes = [...auditObjects, ...receiptObjects], started = Date.now(); let processed = 0;
    const persist = () => this.store.setJSON(stateKey, state, { cacheControl: 'no-store' });
    await persist();
    try {
      await this.store.checkAuditDelete?.();
      while (state.prefix < prefixes.length && processed < maxRecords && Date.now() - started < budgetMs) {
        // List once per prefix, rather than re-reading every object after each deletion.
        const { blobs } = await this.store.list({ prefix: prefixes[state.prefix], consistency: 'strong' });
        const remaining = blobs.map(item => item.key).filter(key => key > state.cursor).sort();
        let offset = 0;
        while (offset < remaining.length && processed < maxRecords && Date.now() - started < budgetMs) {
          const keys = remaining.slice(offset, offset + Math.min(8, maxRecords - processed));
          const results = await Promise.allSettled(keys.map(async key => {
            if (this.store.pruneAuditRecord) return this.store.pruneAuditRecord(key, state.cutoff);
            const value = await this.store.get(key, { type: 'json', consistency: 'strong' });
            const retained = retainedRecord(key, value, state.cutoff);
            if (retained === null) { if (value) await this.store.delete(key); }
            else if (retained !== value) await this.store.setJSON(key, retained, { cacheControl: 'no-store' });
          }));
          const failure = results.find(result => result.status === 'rejected');
          if (failure) throw failure.reason;
          offset += keys.length; processed += keys.length; state.processed += keys.length; state.cursor = keys.at(-1);
          state.error = null; state.failedAt = null; await persist();
        }
        if (offset === remaining.length) { state.prefix++; state.cursor = ''; }
      }
      if (state.prefix >= prefixes.length) { state.completedAt = timestamp; state.lastCompletedAt = timestamp; }
      state.error = null; state.failedAt = null; await persist();
      return { ...state, complete: !!state.completedAt };
    } catch (error) {
      state.failedAt = new Date().toISOString(); state.error = '清理未完成，自动任务会继续重试；也可点击继续清理。';
      await persist().catch(() => {}); throw error;
    }
  }
}
