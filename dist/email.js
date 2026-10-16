export function emailFields() {
  return `<label class="field"><span class="field-label">邮箱</span><input name="email" type="email" required maxlength="254" autocomplete="email" autocapitalize="none" spellcheck="false" placeholder="用于接收验证码和找回密码"></label>
    <div class="email-code-row"><label class="field"><span class="field-label">邮箱验证码</span><input name="code" type="text" required inputmode="numeric" pattern="[0-9]{6}" minlength="6" maxlength="6" autocomplete="one-time-code" placeholder="6 位数字"></label><button type="button" class="button ghost" data-action="send-email-code">获取验证码</button></div><p class="small-note email-code-status" role="status" aria-live="polite"></p>`;
}

// Challenges live only in the current form. Passwords and codes never enter
// localStorage, a draft, or a cross-tab message.
export function createEmailForms(createId) {
  const states = new WeakMap();
  const stateOf = form => {
    if (!states.has(form)) states.set(form, { requestId: createId(), challengeId: null, nextSendAt: 0 });
    return states.get(form);
  };
  const identity = form => JSON.stringify([form.elements.email.value.trim().toLowerCase(), form.elements.username?.value.trim() || '']);
  function refresh(form, state) {
    const button = form.querySelector('[data-action="send-email-code"]');
    if (!button) return;
    const seconds = Math.max(0, Math.ceil((state.nextSendAt - Date.now()) / 1000));
    button.disabled = !!state.sending || seconds > 0;
    button.textContent = state.sending ? '正在发送…' : seconds ? `${seconds} 秒后重发` : state.challengeId ? '重新获取' : '获取验证码';
  }
  return {
    async send(form, db, userId) {
      const email = form.elements.email, username = form.elements.username, currentPassword = form.elements.currentPassword;
      for (const field of [email, username, currentPassword].filter(Boolean)) if (!field.reportValidity()) return;
      const state = stateOf(form);
      if (state.sending || state.nextSendAt > Date.now()) return;
      if (state.identity !== identity(form)) { state.requestId = createId(); state.challengeId = null; }
      state.identity = identity(form); state.sending = true; refresh(form, state);
      try {
        const result = await db.sendEmailCode({ requestId: state.requestId, email: email.value.trim(), purpose: form.dataset.emailPurpose, ...(username ? { username: username.value.trim() } : {}), ...(currentPassword ? { currentPassword: currentPassword.value, expectedUserId: userId } : {}) });
        if (!form.isConnected) return;
        state.challengeId = result.challengeId;
        state.nextSendAt = Date.now() + result.retryAfter * 1000;
        form.elements.code.value = '';
        form.querySelector('.email-code-status').textContent = result.message;
        state.requestId = createId();
        const timer = setInterval(() => { if (!form.isConnected) clearInterval(timer); else { refresh(form, state); if (state.nextSendAt <= Date.now()) clearInterval(timer); } }, 1000);
      } finally { state.sending = false; refresh(form, state); }
    },
    proof(form) {
      const state = stateOf(form);
      if (!state.challengeId || state.identity !== identity(form)) throw new Error('请先为当前邮箱获取验证码。');
      return { email: form.elements.email.value.trim(), code: form.elements.code.value.trim(), challengeId: state.challengeId };
    },
    changed(form, input) {
      const state = states.get(form);
      if (state && ['email', 'username'].includes(input.name) && state.identity !== identity(form)) {
        state.challengeId = null;
        form.querySelector('.email-code-status').textContent = '账号或邮箱已修改，请重新获取验证码。';
        refresh(form, state);
      }
    },
  };
}
