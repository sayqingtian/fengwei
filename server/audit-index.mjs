import { AUDIT_ACTIONS } from './audit-actions.mjs';

export const AUDIT_PREFIX = 'private/audit-index/';
export const auditCursor = entry => `${entry.createdAt}|${entry.id}`;
export const auditTerms = query => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
export function auditMatches(entry, { query = '', result = '', from = '', to = '' } = {}) {
  return (!result || entry.result === result) && (!from || entry.createdAt >= from) && (!to || entry.createdAt < to) && auditTerms(query).every(term => entry.searchText.includes(term));
}
export function publicAudit(entry) {
  const { id, createdAt, userId, displayName, action, target, result, code } = entry;
  return { id, createdAt, userId, displayName, action, target, result, code };
}
export async function indexAudit(store, candidate) {
  if (!candidate || !/^[a-f0-9]{64}$/.test(candidate.id) || !Object.hasOwn(AUDIT_ACTIONS, candidate.action) || !Number.isFinite(Date.parse(candidate.createdAt))) return;
  let entry = publicAudit(candidate);
  const canonical = `private/audit-canonical/${entry.id}.json`;
  try { await store.setJSON(canonical, entry, { onlyIfNew: true, cacheControl: 'no-store' }); }
  catch (error) {
    if (error.code !== 'PRECONDITION_FAILED') throw error;
    entry = await store.get(canonical, { type: 'json', consistency: 'strong' });
    if (!entry) throw new Error('Audit canonical entry unavailable');
  }
  const key = `${AUDIT_PREFIX}${auditCursor(entry)}.json`;
  const searchText = `${entry.displayName} ${entry.userId} ${AUDIT_ACTIONS[entry.action]} ${entry.target}`.toLowerCase();
  try { await store.setJSON(key, { ...entry, searchText }, { onlyIfNew: true, cacheControl: 'no-store' }); }
  catch (error) { if (error.code !== 'PRECONDITION_FAILED') throw error; }
}
