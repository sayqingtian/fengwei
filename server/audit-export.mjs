import { AUDIT_ACTIONS } from './audit.mjs';

const RESULTS = { success: '成功', denied: '权限拦截', failed: '未完成' };
const time = value => new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false });
function csvCell(value) {
  let text = String(value ?? '');
  // Quoting alone does not stop spreadsheet programs evaluating formulas.
  if (/^\s*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function makeAuditExport(items, { format = 'csv', query = '', result = '', from = '', to = '' } = {}, now = new Date()) {
  const rows = items.map(item => ({ id: item.id, createdAt: item.createdAt, time: time(item.createdAt), userId: item.userId, displayName: item.displayName, action: item.action, actionLabel: AUDIT_ACTIONS[item.action] || item.action, target: item.target, result: item.result, resultLabel: RESULTS[item.result] || item.result, code: item.code || '' }));
  const stamp = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const filename = `峰味-操作日志-${stamp}.${format}`;
  if (format === 'json') return { filename, mimeType: 'application/json; charset=utf-8', count: rows.length, content: JSON.stringify({ format: 'fengwei-audit-export', version: 1, exportedAt: now.toISOString(), timeZone: 'Asia/Shanghai', filters: { query, result, ...(from ? { from } : {}), ...(to ? { to } : {}) }, total: rows.length, items: rows }, null, 2) };
  if (format !== 'csv') throw Object.assign(new Error('请选择 CSV 或 JSON 导出格式。'), { status: 400, code: 'INVALID_EXPORT_FORMAT' });
  const header = ['时间（北京时间）', '用户名', '账号 ID', '操作', '操作对象', '结果', '错误码', '日志 ID'];
  const lines = [header, ...rows.map(item => [item.time, item.displayName, item.userId, item.actionLabel, item.target, item.resultLabel, item.code, item.id])];
  return { filename, mimeType: 'text/csv; charset=utf-8', count: rows.length, content: '\uFEFF' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n' };
}
