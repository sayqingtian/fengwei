export const roleName = user => user?.role === 'admin' ? '管理员' : user?.canEdit ? '已授权编辑' : '仅查看';
export const actionNames = {
  'account.register': '注册账号', 'account.login': '登录', 'account.logout': '退出登录',
  'account.password': '修改密码', 'account.delete': '删除账号', 'audit.export': '导出操作日志', 'photo.optimize': '优化图片',
  'account.recovery.request': '申请找回密码', 'account.recovery.reset': '管理员重置密码', 'account.recovery.reject': '拒绝找回申请',
  'recipes.sync': '同步菜谱', 'recipe.view': '查看菜谱', 'recipe.history': '查看历史版本',
  'recipe.create': '新增菜谱', 'recipe.update': '编辑菜谱', 'recipe.delete': '删除菜谱', 'recipe.purge': '彻底删除菜谱',
  'recipe.restore': '恢复历史版本', 'recipe.import': '导入菜谱', 'recipe.favorite': '收藏操作',
  'recipe.cook': '开始跟着做', 'backup.export': '导出备份',
  'permission.request': '申请编辑权限', 'permission.approve': '批准编辑权限',
  'permission.reject': '拒绝申请', 'permission.revoke': '撤销编辑权限',
};
const statusNames = { pending: '待审核', approved: '已批准', rejected: '未通过', revoked: '已撤销' };
const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function myPages({ icon, esc }) {
  const back = () => `<button class="text-button my-back" data-action="back">${icon('back')}返回上一层</button>`;
  const link = (page, mark, title, note) => `<button class="my-link" data-action="navigate" data-page="${page}"><span class="panel-icon">${icon(mark)}</span><span><strong>${title}</strong><small>${note}</small></span>${icon('arrow')}</button>`;
  return {
    back,
    overview(user, favoriteCount, recoveryCount = 0) {
      return `<h1 class="page-title">我的</h1><p class="page-lead">管理自己的账号、权限和菜谱备份。</p><section class="panel my-profile"><div class="panel-icon">${icon('people')}</div><div><h2>${esc(user?.displayName || '')}</h2><p><span class="role-badge">${roleName(user)}</span> · ${favoriteCount} 道个人收藏</p></div></section><div class="my-sections"><section class="panel"><h2>账号与权限</h2>${link('account', 'people', '我的账号', '用户名、登录 ID 与登录状态')}${user?.role !== 'admin' ? link('permissions', 'lock', '账号授权', '说明申请原因，查看审批结果') : ''}</section><section class="panel"><h2>数据管理</h2>${link('backup', 'backup', '菜谱备份', '下载备份、导入菜谱与恢复数据')}${link('sync', 'cloud', '后台同步', '查看待上传修改，重试或处理同步失败')}${link('drafts', 'edit', '本机草稿', '找回未提交的菜谱，仅在此设备保存')}${user?.canEdit ? link('trash', 'trash', '回收站', '找回误删的菜谱，恢复食材、步骤与照片') : ''}</section>${user?.role === 'admin' ? `<section class="panel"><h2>管理员工具</h2>${link('permissions', 'lock', '账号授权', '审批编辑申请，管理与撤销账号权限')}${link('recovery', 'lock', '密码找回', recoveryCount ? `${recoveryCount} 条待处理申请，请核实身份后重置` : '查看找回申请，重置后线下告知用户')}${link('logs', 'clock', '操作日志', '查看用户行为，按账号与操作搜索')}${link('images', 'photo', '图片空间', '查看图片占用，批量压缩已有照片')}</section>` : ''}</div>`;
    },
    permissions(user, data, error = '') {
      const admin = user?.role === 'admin';
      const requests = data?.requests || [], pending = requests.filter(item => item.status === 'pending');
      const accounts = data?.accounts || [];
      const normalize = value => value.normalize('NFKC').trim().toLowerCase();
      const accountRow = account => {
        const duplicates = accounts.filter(item => normalize(item.displayName) === normalize(account.displayName));
        return `<article class="account-row"><div><strong>${esc(account.displayName)}</strong><span class="role-badge">${roleName(account)}</span>${duplicates.length > 1 ? `<p class="small-note">同名账号共 ${duplicates.length} 个，请用账号 ID 区分和登录。</p>` : ''}<p class="small-note account-id">${esc(account.id)}</p>${account.createdAt ? `<p class="small-note">注册时间：${esc(time(account.createdAt))}</p>` : ''}</div>${account.role !== 'admin' ? `<div class="management-actions">${account.canEdit ? `<button class="button danger" data-action="permission-decision" data-kind="revoke" data-user="${esc(account.id)}" data-id="${esc(requests.find(item => item.userId === account.id && item.status === 'approved')?.id || '')}">撤销编辑</button>` : ''}<button class="button danger" data-action="account-delete" data-user="${esc(account.id)}">删除账号</button>${duplicates.length > 1 && duplicates[0].id === account.id ? `<button class="button danger" data-action="account-delete" data-scope="duplicates" data-user="${esc(account.id)}">删除这 ${duplicates.length} 个同名账号</button>` : ''}</div>` : ''}</article>`;
      };
      const entry = item => `<article class="request-card"><div class="request-head"><strong>${esc(item.displayName)}</strong><span class="status-badge status-${item.status}">${statusNames[item.status]}</span></div><p class="request-reason">${esc(item.reason)}</p><p class="small-note">申请时间：${esc(time(item.createdAt))}${item.reviewedAt ? `<br>处理时间：${esc(time(item.reviewedAt))}` : ''}</p>${item.note ? `<p class="review-note">管理员备注：${esc(item.note)}</p>` : ''}${admin && item.status === 'pending' ? `<div class="management-actions"><button class="button primary" data-action="permission-decision" data-kind="approve" data-id="${esc(item.id)}" data-user="${esc(item.userId)}">批准编辑</button><button class="button ghost" data-action="permission-decision" data-kind="reject" data-id="${esc(item.id)}" data-user="${esc(item.userId)}">拒绝申请</button></div>` : ''}</article>`;
      return `${back()}<div class="section-head"><h1 class="page-title">账号授权</h1><button class="button ghost" data-action="reload-permissions">刷新状态</button></div><p class="page-lead">${admin ? '只有 wupanfeng 管理员可以审批和撤销权限。授权包含新增、编辑、删除、导入及恢复历史版本。' : '当前权限：' + roleName(user) + '。编辑权限需说明原因，由 wupanfeng 管理员审核。'}</p>${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}${!data && !error ? '<p class="page-lead" role="status">正在加载授权信息…</p>' : ''}${!admin && data ? `<section class="panel">${user.canEdit ? '<h2>已获得编辑权限</h2><p>现在可以新增、编辑、删除、导入菜谱和恢复历史版本。管理员可以撤销授权。</p>' : pending.length ? '<h2>申请已提交</h2><p>请等待管理员审核。可以继续查看菜谱，点击“刷新状态”查看结果。</p>' : '<h2>申请编辑权限</h2><form id="permission-request-form"><label class="field"><span class="field-label">申请原因</span><textarea name="reason" required minlength="5" maxlength="500" rows="4" placeholder="说明希望编辑哪些菜谱，以及编辑用途（5～500 字）"></textarea></label><p class="small-note">获批后可新增、修改、删除、导入菜谱和恢复历史版本。</p><p id="permission-error" class="form-error" role="alert" hidden></p><button type="submit" class="button primary">提交申请</button></form>'}</section>` : ''}${admin && data ? `<section class="panel"><h2>待审核申请 · ${pending.length}</h2><div class="management-list">${pending.length ? pending.map(entry).join('') : '<p class="empty-management">暂时没有待审核的申请。</p>'}</div></section><section class="panel management-panel"><h2>账号权限 · ${data.accounts.length}</h2><div class="management-list">${data.accounts.map(accountRow).join('')}</div></section>` : ''}${data ? `<section class="panel management-panel"><h2>${admin ? '已处理申请' : '我的申请记录'}</h2><div class="management-list">${(admin ? requests.filter(item => item.status !== 'pending') : requests).map(entry).join('') || '<p class="empty-management">暂无申请记录。</p>'}</div></section>` : ''}`;
    },
    logs(user, data, { query = '', result = '', from = '', to = '', error = '', loading = false, exporting = false, retention = '' } = {}) {
      if (user?.role !== 'admin') return `${back()}<p class="page-lead">只有管理员可以查看操作日志。</p>`;
      return `${back()}<div class="audit-heading"><h1 class="page-title">操作日志</h1><span class="role-badge">最近 7 天</span></div><p class="page-lead audit-lead">查看账号、菜谱与授权操作。过期记录自动清理，时间均为北京时间。</p>
        <section class="panel audit-tools" aria-label="日志筛选与导出"><form id="audit-filter-form" class="audit-filters">
          <label class="search-box">${icon('search')}<input name="query" type="search" enterkeyhint="search" aria-label="搜索日志" maxlength="100" placeholder="搜索账号、操作或菜名" value="${esc(query)}"></label>
          <label class="audit-result">操作结果<select name="result" class="sort-select" aria-label="操作结果"><option value="">所有结果</option><option value="success" ${result === 'success' ? 'selected' : ''}>成功</option><option value="denied" ${result === 'denied' ? 'selected' : ''}>权限拦截</option><option value="failed" ${result === 'failed' ? 'selected' : ''}>未完成</option></select></label>
          <label class="audit-date">开始日期<input name="from" type="date" aria-label="日志开始日期" value="${esc(from)}"></label>
          <label class="audit-date">结束日期<input name="to" type="date" aria-label="日志结束日期" value="${esc(to)}" min="${esc(from)}"></label>
          <button class="button primary audit-submit" type="submit" ${loading ? 'disabled' : ''}>${loading ? '读取中…' : '筛选日志'}</button>
        </form><div class="audit-export-actions"><p>导出当前筛选结果<span>每次最多 10000 条，可按日期分批</span></p><div class="management-actions"><button class="button ghost" data-action="export-audit" data-format="csv" ${loading || exporting ? 'disabled' : ''}>${icon('download')}${exporting ? '正在导出…' : '导出 CSV'}</button><button class="button ghost" data-action="export-audit" data-format="json" ${loading || exporting ? 'disabled' : ''}>${icon('download')}导出 JSON</button></div></div></section>
        ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}
        <section class="audit-panel" aria-label="操作记录"><div class="audit-list">${data?.items.map(item => `<article class="audit-row"><div class="audit-row-heading"><strong>${esc(actionNames[item.action] || item.action)}</strong><span class="status-badge status-${item.result === 'success' ? 'approved' : 'rejected'}">${{ success: '成功', denied: '权限拦截', failed: '未完成' }[item.result] || esc(item.result)}</span></div><time class="audit-time" datetime="${esc(item.createdAt)}">${esc(time(item.createdAt))}</time><dl class="audit-details"><div><dt>用户</dt><dd>${esc(item.displayName || '未登录用户')}</dd></div>${item.target ? `<div><dt>对象</dt><dd>${esc(item.target)}</dd></div>` : ''}</dl>${item.userId ? `<details class="audit-identity"><summary>账号 ID</summary><p class="account-id">${esc(item.userId)}</p></details>` : ''}</article>`).join('') || `<p class="panel empty-management">${data?.indexing ? `正在整理历史日志，已检查 ${data.indexing.processed} 条…` : loading ? '正在读取操作日志…' : '暂无符合条件的操作记录。'}</p>`}</div>${data?.cursor ? '<button class="button ghost load-more" data-action="load-more-logs">加载更早记录</button>' : ''}</section>
        ${retention}<p class="small-note">“查看菜谱”和“开始跟着做”仅记录联网时的操作。</p>`;
    },
  };
}
