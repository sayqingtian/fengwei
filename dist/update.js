import { APP_VERSION } from './version.js';

export function createUpdater({ changed = () => {}, reload = () => location.reload() } = {}) {
  let registration, starting, running, latest = '', status = '', busy = false, lastCheck = 0;
  const supported = 'serviceWorker' in navigator && window.isSecureContext;
  const emit = () => changed();
  function watch(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) { status = '新版本已准备好，点击更新即可使用。'; emit(); } });
  }
  async function start() {
    if (!supported) return null;
    if (!starting) starting = navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then(value => {
      registration = value; watch(value.installing);
      value.addEventListener('updatefound', () => watch(value.installing));
      return value;
    }).catch(error => { starting = null; throw error; });
    return starting;
  }
  async function check(manual = false) {
    if (running) return running;
    if (!manual && Date.now() - lastCheck < 60000) return;
    if (navigator.onLine === false) { if (manual) { status = '当前离线，请联网后检查更新。'; emit(); } return; }
    lastCheck = Date.now(); busy = true; if (manual) status = '正在检查新版本…'; emit();
    running = (async () => {
      try {
        const url = new URL('./version.json', import.meta.url); url.searchParams.set('check', Date.now());
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('版本信息暂时不可用，请稍后重试。');
        const info = await response.json();
        if (typeof info.version !== 'string' || !/^\d+\.\d+\.\d+(?:\+\d+)?$/.test(info.version)) throw new Error('版本信息暂时不可用，请稍后重试。');
        latest = info.version;
        const reg = await start(); if (reg) await reg.update();
        status = latest !== APP_VERSION || reg?.waiting ? '发现新版本，可以更新。' : '当前已是最新版本。';
      } catch (error) { if (manual) status = error.name === 'TimeoutError' ? '检查超时，请稍后重试。' : '检查更新失败，请确认网络后重试。'; }
      finally { busy = false; running = null; emit(); }
    })();
    return running;
  }
  async function apply() {
    if (busy) return;
    busy = true; status = '正在下载更新，请稍候…'; emit();
    try {
      const reg = await start();
      if (!reg) { reload(); return; }
      await reg.update();
      if (reg.installing) await new Promise((resolve, reject) => {
        const worker = reg.installing, timer = setTimeout(() => finish(new Error('下载更新超时，请重试。')), 25000);
        function finish(error) { clearTimeout(timer); worker.removeEventListener('statechange', change); error ? reject(error) : resolve(); }
        function change() { if (worker.state === 'installed' || worker.state === 'activated') finish(); else if (worker.state === 'redundant') finish(new Error('下载更新未完成，请重试。')); }
        worker.addEventListener('statechange', change); change();
      });
      if (reg.waiting) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', change); reject(new Error('更新暂未完成，请重试。')); }, 12000);
          function change() { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', change); resolve(); }
          navigator.serviceWorker.addEventListener('controllerchange', change);
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        });
      } else if (latest && latest !== APP_VERSION && navigator.serviceWorker.controller) {
        // The server can briefly serve an old worker during a rolling deployment.
        // Keep the existing offline shell until a complete replacement is ready.
        const version = await new Promise(resolve => {
          const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); resolve(''); }, 2000);
          channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data?.version); };
          navigator.serviceWorker.controller.postMessage({ type: 'VERSION' }, [channel.port2]);
        });
        if (version !== latest) throw new Error('新版本仍在发布，请稍后再更新。');
      }
      status = '更新已准备好，正在重新打开…'; emit(); reload();
    } catch (error) { status = error.message || '更新失败，请稍后重试。'; }
    finally { busy = false; emit(); }
  }
  return { start, check, apply, get ready() { return !!registration?.active; }, get state() { return { version: APP_VERSION, latest, status, busy, available: (!!latest && latest !== APP_VERSION) || !!registration?.waiting }; } };
}
