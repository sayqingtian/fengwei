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
export class AuditRetention {
  constructor(store) { this.store = store; }
  async run({ maxRecords = 120, budgetMs = 2000, now = Date.now() } = {}) {
    const stateKey = 'private/audit-retention/v1.json', cutoff = auditCutoff(now);
    let state = await this.store.get(stateKey, { type: 'json', consistency: 'strong' }) || { prefix: 0, cursor: '' };
    if (state.completedAt && now - Date.parse(state.completedAt) < 3600000) return state;
    if (state.completedAt) state = { prefix: 0, cursor: '' };
    const prefixes = [...auditObjects, ...receiptObjects], started = Date.now(); let processed = 0;
    while (state.prefix < prefixes.length && processed < maxRecords && Date.now() - started < budgetMs) {
      const { blobs } = await this.store.list({ prefix: prefixes[state.prefix], consistency: 'strong' });
      const remaining = blobs.map(item => item.key).filter(key => key > state.cursor).sort();
      const keys = remaining.slice(0, Math.min(8, maxRecords - processed));
      await Promise.all(keys.map(async key => {
        if (this.store.pruneAuditRecord) return this.store.pruneAuditRecord(key, cutoff);
        const value = await this.store.get(key, { type: 'json', consistency: 'strong' });
        const retained = retainedRecord(key, value, cutoff);
        if (retained === null) { if (value) await this.store.delete(key); }
        else if (retained !== value) await this.store.setJSON(key, retained, { cacheControl: 'no-store' });
      }));
      processed += keys.length;
      if (remaining.length <= keys.length) { state.prefix++; state.cursor = ''; } else state.cursor = keys.at(-1);
    }
    state = { ...state, cutoff, ...(state.prefix >= prefixes.length ? { completedAt: new Date(now).toISOString() } : {}) };
    await this.store.setJSON(stateKey, state, { cacheControl: 'no-store' });
    return { ...state, processed, complete: !!state.completedAt };
  }
}
