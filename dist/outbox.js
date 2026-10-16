// Durable, account-scoped intent queue. Network work never runs in the local
// transaction, so a slow upload cannot block the next tap or local save.
export function createOutbox({ local, owner, send, concurrency = 3, changed = () => {}, committed = () => {}, ready = () => true }) {
  const key = `fengwei-user:${owner}:outbox-v1`;
  let state = { jobs: [], receipts: {} }, tail = Promise.resolve(), running = null, timer, closed = false, authorized = false, wakeDrain = () => {};
  const transient = error => !error.status || error.status === 429 || error.status >= 500 || error.code === 'INVALID_RESPONSE';
  function edit(work) {
    const run = async () => {
      if (!local) throw new Error('浏览器无法保存后台任务，请允许网站存储后重试。');
      const update = value => { const next = structuredClone(value || { jobs: [], receipts: {} }); work(next); return next; };
      const next = local.updateSetting ? await local.updateSetting(key, update) : await (async () => { const value = update(await local.setting(key)); await local.setSetting(key, value); return value; })();
      state = next; wakeDrain(); if (!closed) changed(); return next;
    };
    const job = tail.then(run); tail = job.catch(() => {}); return job;
  }
  async function reload() { await tail; state = await local?.setting(key) || { jobs: [], receipts: {} }; if (!closed) changed(); }
  function schedule() {
    clearTimeout(timer);
    if (closed || !ready() || !state.jobs.some(job => job.status !== 'failed')) return;
    timer = setTimeout(() => { drain().catch(() => {}); }, 2000); timer.unref?.();
  }
  async function work() {
    await reload();
    const attempted = new Set(), waiting = new Set(); let active = 0;
    const wake = () => { for (const resolve of waiting) resolve(); waiting.clear(); };
    wakeDrain = wake;
    async function worker() {
    while (!closed && ready()) {
      const job = state.jobs.find((item, index, jobs) => item.status !== 'failed' && !attempted.has(item.token) && (!item.retryAt || item.retryAt <= Date.now()) && !jobs.slice(0, index).some(previous => previous.id === item.id));
      if (!job) { if (!active) break; await new Promise(resolve => waiting.add(resolve)); continue; }
      attempted.add(job.token); active++;
      try {
      // Resolve only a confirmed local predecessor, never a remote head. This
      // preserves conflict detection when another device has edited the recipe.
      const dependency = job.value.baseRevision?.startsWith('local:') ? job.value.baseRevision.slice(6) : null;
      if (dependency && !state.receipts[dependency]) {
        await edit(next => { const item = next.jobs.find(item => item.token === job.token); if (item) Object.assign(item, { status: 'failed', error: '前一次本机保存尚未确认，请先处理之前的任务。', code: 'DEPENDENCY' }); }); continue;
      }
      await edit(next => { const item = next.jobs.find(item => item.token === job.token); if (item) { item.status = 'sending'; item.attempts = (item.attempts || 0) + 1; if (dependency) item.value.baseRevision = next.receipts[dependency]; } });
      const sending = state.jobs.find(item => item.token === job.token); if (!sending) continue;
      try {
        const result = await send(structuredClone(sending));
        await edit(next => {
          next.jobs = next.jobs.filter(item => item.token !== job.token);
          if (result?.revision) next.receipts[job.token] = result.revision;
        });
        if (!closed) committed(sending);
      } catch (error) {
        await edit(next => {
          const item = next.jobs.find(item => item.token === job.token); if (!item) return;
          Object.assign(item, { status: transient(error) ? 'pending' : 'failed', error: error.message, code: error.code, retryAt: Date.now() + (error.status === 429 ? 60000 : Math.min(60000, 2000 * 2 ** Math.min(item.attempts, 5))) });
        });
      }
      } finally { active--; wake(); }
    }
    }
    const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(3, concurrency)) }, worker));
    wakeDrain = () => {};
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }
  function drain() {
    if (running) return running;
    if (closed || !ready()) return Promise.resolve();
    const locked = () => globalThis.navigator?.locks ? navigator.locks.request(`fengwei-outbox:${owner}`, { ifAvailable: true }, lock => lock ? work() : reload()) : work();
    const job = locked().finally(() => { if (running === job) running = null; schedule(); }); running = job; return job;
  }
  return {
    get jobs() { return structuredClone(state.jobs); },
    revision(token) { return state.receipts[token]; },
    reload,
    async authorize() {
      if (authorized) return;
      if (state.jobs.length) await edit(next => { for (const job of next.jobs) if (job.status !== 'failed' || ['LOGIN_REQUIRED', 'ACCOUNT_CHANGED'].includes(job.code)) { job.status = 'pending'; job.retryAt = 0; } });
      authorized = true;
    },
    async enqueue(job) {
      if (closed) throw new Error('账号已切换，请重新登录后保存。');
      await edit(next => {
        // Collapse taps that have never left the device. Once sent, an intent
        // keeps its ID/body until the server confirms it, even after a timeout.
        if (job.kind === 'favorite') next.jobs = next.jobs.filter(item => !(item.kind === 'favorite' && item.id === job.id && item.status === 'pending' && !item.attempts));
        next.jobs.push({ ...structuredClone(job), status: 'pending', createdAt: new Date().toISOString() });
      });
      drain().catch(() => {});
    },
    async retry() { await edit(next => { for (const job of next.jobs) { job.status = 'pending'; job.retryAt = 0; } }); await drain(); },
    async discard(token) {
      await edit(next => {
        const job = next.jobs.find(item => item.token === token);
        if (!job || job.status !== 'failed') throw new Error('此任务尚在确认服务器结果，暂不能移除。');
        // Later intents for the same recipe can depend on this rejected write.
        next.jobs = next.jobs.filter(item => item.id !== job.id);
      });
    },
    drain,
    close() { closed = true; clearTimeout(timer); wakeDrain(); },
  };
}
