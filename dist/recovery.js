const statusNames = { pending: '待处理', processing: '正在处理', reset: '已重置', rejected: '已拒绝', stale: '密码已变更', expired: '已过期' };
const time = value => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

export function recoveryPages({ esc, icon }) {
  return {
    request(message = '') {
      return `<div class="auth-overlay"><section class="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title">
        <span class="boot-mark">峰味</span><h1 id="auth-title">找回密码</h1>
        ${message ? `<div class="recovery-success" role="status"><h2>申请已受理</h2><p>${esc(message)}</p><p>请等待管理员联系，收到新密码后返回登录。</p></div>` : `<p>填写账号和线下联系方式，将申请发送给管理员。核实身份后，管理员会重置密码并线下告知。</p>
        <form id="password-recovery-form">
          <label class="field"><span class="field-label">账号</span><input name="username" type="text" required maxlength="64" placeholder="用户名或账号 ID" autocomplete="username" autocapitalize="none" spellcheck="false"></label>
          <label class="field"><span class="field-label">线下联系方式</span><input name="contact" type="text" required minlength="2" maxlength="100" placeholder="手机号、微信或其他可联系到你的方式" autocomplete="off"></label>
          <label class="field"><span class="field-label">备注（选填）</span><textarea name="reason" maxlength="500" rows="3" placeholder="可说明注册时间等方便管理员核实的信息，请勿填写密码"></textarea></label>
          <p id="recovery-error" class="form-error" role="alert" hidden></p><button class="button primary" type="submit">发送找回申请</button>
        </form>`}
        <button class="text-button recovery-back" data-action="auth-login">${icon('back')}返回登录</button>
      </section></div>`;
    },
    inbox(user, data, { error = '', loading = false } = {}) {
      if (user?.role !== 'admin') return '<p class="page-lead">只有管理员可以查看密码找回申请。</p>';
      const requests = data?.requests || [], pending = requests.filter(item => ['pending', 'processing'].includes(item.status));
      const card = item => `<article class="request-card"><div class="request-head"><strong>${esc(item.displayName)}</strong><span class="status-badge status-${item.status === 'reset' ? 'approved' : item.status === 'pending' ? 'pending' : 'rejected'}">${statusNames[item.status] || '待处理'}</span></div>
        <p class="small-note account-id">账号 ID：${esc(item.userId)}</p><p class="request-reason">线下联系方式：${esc(item.contact)}</p>
        ${item.reason ? `<p class="request-reason">申请备注：${esc(item.reason)}</p>` : ''}<p class="small-note">申请时间：${esc(time(item.createdAt))}${item.reviewedAt ? `<br>处理时间：${esc(time(item.reviewedAt))}` : ''}</p>
        ${item.note ? `<p class="review-note">管理员备注：${esc(item.note)}</p>` : ''}${item.status === 'pending' ? `<div class="management-actions"><button class="button primary" data-action="recovery-decision" data-kind="reset" data-id="${esc(item.id)}" data-user="${esc(item.userId)}">重置密码</button><button class="button ghost" data-action="recovery-decision" data-kind="reject" data-id="${esc(item.id)}" data-user="${esc(item.userId)}">拒绝申请</button></div>` : ''}</article>`;
      return `<div class="section-head"><h1 class="page-title">密码找回</h1><button class="button ghost" data-action="reload-recovery" ${loading ? 'disabled' : ''}>${loading ? '读取中…' : '刷新申请'}</button></div>
        <p class="page-lead">先通过已有的线下联系渠道核实账号主人身份，再设置新密码并线下告知。申请中填写的联系方式仅供参考。</p>
        ${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}<section class="panel"><h2>待处理申请 · ${pending.length}</h2><div class="management-list">${pending.length ? pending.map(card).join('') : `<p class="empty-management">${loading && !data ? '正在读取找回申请…' : '暂时没有待处理的找回申请。'}</p>`}</div></section>
        <section class="panel management-panel"><h2>已处理与失效申请</h2><div class="management-list">${requests.filter(item => !pending.includes(item)).map(card).join('') || '<p class="empty-management">暂无记录。</p>'}</div></section>`;
    },
    decision(item, action) {
      const reset = action === 'reset', title = reset ? '重置账号密码' : '拒绝找回申请';
      return `<div class="modal-header"><h2 id="modal-title" tabindex="-1">${title}</h2><button class="icon-button" data-action="close" aria-label="关闭密码找回操作">${icon('close')}</button></div>
        <div class="modal-scroll"><p class="page-lead">账号：${esc(item.displayName)}<br>线下联系方式：${esc(item.contact)}</p><form id="recovery-decision-form">
        ${reset ? `<label class="field"><span class="field-label">新密码</span><input name="newPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password" placeholder="设置 8～128 个字符的新密码"></label>
          <button class="text-button" type="button" data-action="generate-recovery-password">生成随机密码</button>
          <label class="field"><span class="field-label">确认新密码</span><input name="confirmPassword" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label>
          <label class="recovery-identity"><input name="identityVerified" type="checkbox" required><span>我已通过已有的线下联系渠道核实账号主人身份</span></label><p class="small-note">重置后，原密码和已有登录会失效。成功后请复制新密码，线下告知用户。</p>` : '<p class="small-note">拒绝申请后，账号密码及登录状态保持原样。</p>'}
        <label class="field"><span class="field-label">管理员备注（选填）</span><textarea name="note" maxlength="500" rows="2" placeholder="记录核实情况或处理原因，请勿填写密码"></textarea></label>
        <p id="recovery-decision-error" class="form-error" role="alert" hidden></p><button type="submit" class="button primary">${reset ? '确认重置密码' : '确认拒绝申请'}</button></form></div>`;
    },
    completed(item, password) {
      return `<div class="modal-header"><h2 id="modal-title" tabindex="-1">密码已重置</h2><button class="icon-button" data-action="close" aria-label="关闭重置结果">${icon('close')}</button></div><div class="modal-scroll">
        <p class="page-lead">账号：${esc(item.displayName)}<br>请通过线下方式将新密码告知已核实身份的用户。</p>
        <label class="field"><span class="field-label">新密码（关闭后不再显示）</span><input id="recovery-result-password" type="text" readonly autocomplete="off" value="${esc(password)}"></label>
        <button class="button primary" data-action="copy-recovery-password">${icon('share')}复制新密码</button><p class="small-note">用户可用新密码登录，并在“我的账号 → 修改密码”中设置自己的密码。</p></div>`;
    },
  };
}
