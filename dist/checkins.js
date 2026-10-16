export function pendingCheckins(data, jobs = []) {
  const items = new Map((data?.items || []).map(item => [item.id, item]));
  let total = data?.total || 0;
  const relevant = jobs.filter(job => job.kind === 'checkin' || job.kind === 'checkin-delete');
  for (const job of relevant) {
    if (job.kind === 'checkin') {
      if (!items.has(job.checkinId)) total++;
      items.set(job.checkinId, { id: job.checkinId, recipeId: job.value.recipeId, title: job.title, note: job.value.note, cookedAt: job.cookedAt, pending: true, failed: job.status === 'failed' });
    } else if (job.status !== 'failed' && items.delete(job.checkinId)) total--;
  }
  return data || relevant.length ? { ...data, items: [...items.values()].sort((a, b) => b.cookedAt.localeCompare(a.cookedAt)), total: Math.max(0, total), dishes: relevant.length ? null : data?.dishes } : null;
}
export function checkinPages({ icon, esc }) {
  const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
  const entry = item => `<article class="checkin-entry" data-checkin-id="${esc(item.id)}"><div class="request-head"><h2>${esc(item.title)}</h2><span class="status-badge ${item.failed ? 'status-rejected' : item.pending ? 'status-pending' : 'status-approved'}">${item.failed ? '同步失败' : item.pending ? '待同步' : '已完成'}</span></div><p class="small-note">${esc(time(item.cookedAt))}</p>${item.note ? `<p class="checkin-note">${esc(item.note)}</p>` : ''}<div class="management-actions"><button class="text-button" data-action="detail" data-id="${esc(item.recipeId)}">查看菜谱${icon('arrow')}</button><button class="text-button danger" data-action="delete-checkin" data-id="${esc(item.id)}" aria-label="删除 ${esc(item.title)} 的这次打卡">删除打卡</button></div></article>`;
  return {
    form(recipe) {
      return `<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">制作完成，打个卡</h2><div class="header-label">${esc(recipe.title)}</div></div><button class="icon-button" data-action="close" aria-label="关闭打卡">${icon('close')}</button></div><div class="modal-scroll"><div class="checkin-celebrate">${icon('check')}<h3>又好好吃了一餐</h3><p>记录这次下厨，留住自己的进步。</p></div><form id="checkin-form"><label class="field"><span class="field-label">这次下厨的心得（选填）</span><textarea name="note" maxlength="1000" rows="4" placeholder="味道如何？下次想试试什么改进？"></textarea></label><p class="small-note">打卡仅自己可见，记录提交时间。每次下厨都可以再打卡。</p><p id="checkin-error" class="form-error" role="alert" hidden></p></form></div><div class="modal-footer"><button class="button ghost" data-action="checkin-back" data-id="${esc(recipe.id)}">返回菜谱</button><button class="button primary" type="submit" form="checkin-form">${icon('check')}提交打卡</button></div>`;
    },
    history(data, { loading = false, error = '' } = {}) {
      return `<div class="section-head"><h1 class="page-title">我的打卡</h1><button class="button ghost" data-action="reload-checkins" ${loading ? 'disabled' : ''}>${loading ? '加载中…' : '刷新记录'}</button></div><p class="page-lead">每一次认真下厨，都值得记下来。记录仅自己可见。提交和删除会先保存在本机，再后台同步。</p>${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}${data ? `<div class="checkin-stats"><span><strong>${data.total}</strong> 次完成打卡</span><span><strong>${data.dishes ?? '—'}</strong> 道做过的菜</span></div>` : ''}<section class="panel"><div class="checkin-list">${data?.items.length ? data.items.map(entry).join('') : `<p class="empty-management">${loading ? '正在加载打卡记录…' : error ? '暂时无法加载记录，请联网后重试。' : '还没有打卡。做好一道菜后，在菜谱详情里记录第一次吧。'}</p>`}</div>${data?.cursor ? `<button class="button ghost load-more" data-action="more-checkins" ${loading ? 'disabled' : ''}>加载更早记录</button>` : ''}</section>`;
    },
  };
}
