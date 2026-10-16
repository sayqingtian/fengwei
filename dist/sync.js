import { createId, validateRecipe } from './store.js';

const CACHE_KEY = 'fengwei-server-cache-v2';
const OLD_CACHE_KEY = 'fengwei-server-cache-v1';
const CACHE_AGE = 90 * 24 * 3600 * 1000;
async function parallel(items, work, limit = 6) {
  const result = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await work(items[index], index); }
  }));
  return result;
}
export class ApiError extends Error {
  constructor(message, status, code) { super(message); Object.assign(this, { status, code }); }
}
export async function createRemoteStore(local) {
  let snapshot = await local?.setting(CACHE_KEY).catch(() => null) || null;
  if (!snapshot?.user?.id) snapshot = null;
  let offline = false, authenticated = false, user = snapshot?.user || null;
  let records = snapshot?.recipes || [], revisions = Object.assign(Object.create(null), snapshot?.revisions || {});
  let hashes = Object.assign(Object.create(null), snapshot?.photoHashes || {}), conflicts = [];
  const photoCache = new Map();
  for (const recipe of records) { const key = hashes[recipe.id]; if (key && recipe.photo) photoCache.set(key, recipe.photo); }
  let cacheWarning = !local;
  let accountEpoch = 0, syncing = null;
  const photoLoads = new Map();
  let batchPhotos = true, photoReferences = false;
  const apiBase = new URL('./api/', import.meta.url);
  function resetMemory() {
    accountEpoch++; photoLoads.clear(); photoReferences = false;
    snapshot = null; records = []; revisions = Object.create(null); hashes = Object.create(null);
    conflicts = []; photoCache.clear(); user = null; authenticated = false; offline = false;
  }
  async function forget(clearLocal = true) {
    resetMemory();
    if (clearLocal && local) {
      try { await local.setSetting(CACHE_KEY, null); await local.setSetting(OLD_CACHE_KEY, null); }
      catch { cacheWarning = true; return false; }
    }
    return true;
  }
  async function acceptUser(nextUser) {
    if (!nextUser?.id || !nextUser.displayName) throw new ApiError('服务器账号接口未就绪，请部署完整新版。', 503, 'INVALID_ACCOUNT');
    if (user?.id !== nextUser.id) await forget();
    user = nextUser;
  }
  async function request(path, { method = 'GET', value } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetch(new URL(path, apiBase), { method, credentials: 'same-origin', cache: 'no-store', headers: value === undefined ? {} : { 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.timeout(25000) });
      } catch { throw new ApiError('服务器暂时连不上。缓存仍可查看，修改需要联网后再保存。', 0, 'NETWORK'); }
      let data;
      try { data = await response.json(); } catch { throw new ApiError('服务器接口未就绪，请确认上传了包含云函数的完整峰味部署包。', response.status, 'INVALID_RESPONSE'); }
      // Retries preserve the exact registration/mutation ID. These errors occur
      // before the platform's request body is available for a server mutation.
      if (response.status === 400 && ['EMPTY_BODY', 'BODY_UNREADABLE'].includes(data.code) && attempt < 2) continue;
      if (!response.ok) {
        if (response.status === 401) {
          await forget();
          if (!['login', 'register'].includes(path)) globalThis.dispatchEvent?.(new Event('fengwei:login-required'));
        }
        if (data.code === 'ACCOUNT_CHANGED') {
          await forget(); globalThis.dispatchEvent?.(new Event('fengwei:login-required'));
        }
        if (data.code === 'EDIT_PERMISSION_REQUIRED') {
          await acceptUser((await request('me')).user); await persist();
          globalThis.dispatchEvent?.(new Event('fengwei:permissions-changed'));
        }
        throw new ApiError(data.error || '服务器未完成操作，请重试。', response.status, data.code);
      }
      return data;
    }
  }
  async function sameAccount(data) {
    if (data.userId && data.userId !== user?.id) {
      await forget(); globalThis.dispatchEvent?.(new Event('fengwei:login-required'));
      throw new ApiError('账号已在其他页面切换，请重新同步后操作。', 409, 'ACCOUNT_CHANGED');
    }
  }
  async function persist() {
    snapshot = { user, recipes: records, revisions, photoHashes: hashes, authenticatedAt: Date.now() };
    if (local) {
      try { await local.setSetting(CACHE_KEY, snapshot); cacheWarning = false; }
      catch { cacheWarning = true; }
    }
  }
  async function hydrate(item) {
    if (item.deleted) return null;
    let photo = '';
    if (item.photoHash) {
      photo = photoCache.get(item.photoHash);
      if (!photo) {
        const key = item.photoHash;
        if (!photoLoads.has(key)) {
          const loading = request(`photo/${key}`).then(data => { photoCache.set(key, data.photo); return data.photo; }).finally(() => { if (photoLoads.get(key) === loading) photoLoads.delete(key); });
          photoLoads.set(key, loading);
        }
        photo = await photoLoads.get(key);
      }
    }
    return validateRecipe({ ...item.recipe, photo });
  }
  async function loadPhotos(items) {
    if (!batchPhotos) return;
    const missing = [...new Set(items.filter(item => !item.deleted && item.photoHash && !photoCache.has(item.photoHash)).map(item => item.photoHash))];
    const groups = []; for (let i = 0; i < missing.length; i += 8) groups.push(missing.slice(i, i + 8));
    globalThis.dispatchEvent?.(new CustomEvent('fengwei:sync-progress', { detail: { photos: missing.length } }));
    await parallel(groups, async hashes => {
      let pending = hashes;
      while (pending.length) {
        let data;
        try { data = await request('photos', { method: 'POST', value: { hashes: pending } }); }
        catch (error) { if (error.status === 404 && error.code === 'NOT_FOUND') { batchPhotos = false; return; } throw error; }
        await sameAccount(data);
        for (const [key, photo] of Object.entries(data.photos || {})) if (pending.includes(key)) photoCache.set(key, photo);
        const remaining = data.pending || [];
        if (remaining.length >= pending.length || remaining.some(key => !pending.includes(key))) throw new ApiError('照片读取未完成，请重新同步。', 503, 'INVALID_RESPONSE');
        pending = remaining;
      }
    }, 3);
  }
  function ensureOnline() {
    if (offline || globalThis.navigator?.onLine === false) throw new ApiError('当前为离线预览，修改还没有保存。联网后请先同步，再保存。', 0, 'OFFLINE');
  }
  async function write(id, recipe, method = 'PUT', options = {}) {
    ensureOnline();
    const valid = recipe ? validateRecipe(recipe) : null;
    const reused = photoReferences && valid?.photo && hashes[id] && photoCache.get(hashes[id]) === valid.photo ? hashes[id] : '';
    const data = await request(`recipe/${encodeURIComponent(id)}`, { method, value: { ...(valid ? { recipe: { ...valid, photo: reused ? '' : valid.photo } } : {}), ...(reused ? { photoHash: reused } : {}), baseRevision: Object.hasOwn(options, 'baseRevision') ? options.baseRevision : revisions[id] || null, mutationId: createId(), ...(options.operation ? { operation: options.operation } : {}) } });
    await sameAccount(data);
    const item = data.item;
    revisions[id] = item.revision; hashes[id] = item.photoHash;
    conflicts = conflicts.filter(key => key !== id); if (item.conflictCount > 1) conflicts.push(id);
    records = records.filter(record => record.id !== id);
    if (!item.deleted) {
      if (recipe?.photo && item.photoHash) photoCache.set(item.photoHash, recipe.photo);
      records.push(await hydrate(item));
    }
    authenticated = true; await persist();
  }
  async function setFavorite(id, favorite) {
    ensureOnline();
    const data = await request(`favorite/${encodeURIComponent(id)}`, { method: 'PUT', value: { favorite, expectedUserId: user?.id, mutationId: createId() } });
    await sameAccount(data);
    records = records.map(recipe => recipe.id === id ? { ...recipe, favorite: data.favorite } : recipe);
    await persist();
  }
  async function synchronize(job) {
    try {
      const next = [], newRevisions = Object.create(null), newHashes = Object.create(null), newConflicts = [];
      let cursor = null, first = true;
      do {
        const data = await request(`recipes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
        if (first) {
          const principal = data.user || (await request('me')).user;
          if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
          await acceptUser(principal); job.epoch = accountEpoch; first = false;
        }
        await sameAccount(data);
        photoReferences = data.capabilities?.photoReferences === true;
        await loadPhotos(data.items);
        const hydrated = await parallel(data.items, hydrate);
        if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i]; newRevisions[item.id] = item.revision; newHashes[item.id] = item.photoHash;
          if (item.conflictCount > 1) newConflicts.push(item.id); if (hydrated[i]) next.push(hydrated[i]);
        }
        cursor = data.cursor;
      } while (cursor);
      records = next; revisions = newRevisions; hashes = newHashes; conflicts = newConflicts;
      offline = false; authenticated = true; await persist(); return records;
    } catch (error) {
      if (error.status === 401) throw error;
      if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
      if ((error.code === 'NETWORK' || error.code === 'STORAGE_UNAVAILABLE') && snapshot?.user && Date.now() - snapshot.authenticatedAt < CACHE_AGE) { offline = true; authenticated = true; return records; }
      throw error;
    }
  }
  return {
    get user() { return user; },
    get readOnly() { return offline; },
    get canEdit() { return !offline && !!user?.canEdit; },
    get authenticated() { return authenticated; },
    get conflicts() { return conflicts; },
    get cacheWarning() { return cacheWarning; },
    current: () => records.slice(),
    revision: id => revisions[id] || null,
    all() {
      if (syncing?.epoch === accountEpoch) return syncing.promise;
      const job = { epoch: accountEpoch };
      job.promise = synchronize(job).finally(() => { if (syncing === job) syncing = null; }); syncing = job;
      return job.promise;
    },
    put: (recipe, options) => write(recipe.id, recipe, 'PUT', options),
    remove: id => write(id, null, 'DELETE'),
    setFavorite,
    async import(incoming, { favorites = incoming } = {}) {
      incoming = incoming.map(validateRecipe); favorites = favorites.map(validateRecipe); ensureOnline();
      let completed = 0;
      try {
        for (const recipe of incoming) { await write(recipe.id, recipe, 'PUT', { operation: 'import' }); completed++; }
        // Merge positive favorites into this account; do not clear any existing
        // selections when importing generic recipes or another recipe backup.
        for (const recipe of favorites) if (recipe.favorite && !records.find(item => item.id === recipe.id)?.favorite) await setFavorite(recipe.id, true);
      } catch (error) { error.message = `已保存 ${completed} 道，剩余菜谱或收藏尚未导入。${error.message}`; throw error; }
    },
    async checkins(cursor = '') {
      ensureOnline(); const epoch = accountEpoch;
      const data = await request(`checkins${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (epoch !== accountEpoch) throw new ApiError('账号已切换，请重新加载打卡记录。', 409, 'ACCOUNT_CHANGED');
      await sameAccount(data); return data;
    },
    async checkin(value) {
      ensureOnline(); const epoch = accountEpoch;
      const data = await request('checkins', { method: 'POST', value });
      if (epoch !== accountEpoch) throw new ApiError('账号已切换，请重新加载打卡记录。', 409, 'ACCOUNT_CHANGED');
      await sameAccount(data); return data.item;
    },
    async login(username, password) {
      const data = await request('login', { method: 'POST', value: { username, password } });
      accountEpoch++;
      await acceptUser(data.user); offline = false; authenticated = true;
    },
    async register(displayName, password, registrationId) {
      const data = await request('register', { method: 'POST', value: { displayName, password, registrationId } });
      accountEpoch++;
      await acceptUser(data.user); offline = false; authenticated = true;
    },
    async requestPasswordRecovery(value) { ensureOnline(); return request('account/recovery', { method: 'POST', value }); },
    async passwordRecoveries() { ensureOnline(); const data = await request('admin/password-recovery'); await sameAccount(data); return data; },
    async decidePasswordRecovery(value) {
      ensureOnline(); const data = await request('admin/password-recovery/decision', { method: 'POST', value: { ...value, expectedUserId: user?.id } });
      await sameAccount(data); if (data.user) { await acceptUser(data.user); await persist(); } return data.item;
    },
    async logout() {
      ensureOnline(); await request('logout', { method: 'POST', value: {} });
      return forget();
    },
    forget,
    async refreshUser() { ensureOnline(); await acceptUser((await request('me')).user); await persist(); return user; },
    async changePassword(value) {
      ensureOnline(); const data = await request('account/password', { method: 'POST', value });
      await sameAccount(data); await acceptUser(data.user); await persist(); return user;
    },
    async permissions() { ensureOnline(); const data = await request('permissions'); await sameAccount(data); await acceptUser(data.user); await persist(); return data; },
    async requestPermission(reason, requestId) { ensureOnline(); const data = await request('permissions/request', { method: 'POST', value: { reason, requestId } }); await sameAccount(data); return data; },
    async decidePermission(value) { ensureOnline(); const data = await request('permissions/decision', { method: 'POST', value }); await sameAccount(data); return data; },
    async audit({ cursor = '', query = '', result = '' } = {}) {
      ensureOnline(); const params = new URLSearchParams({ cursor, q: query, result });
      const data = await request(`audit?${params}`); await sameAccount(data); return data;
    },
    async exportAudit(format, { query = '', result = '' } = {}) {
      ensureOnline(); const params = new URLSearchParams({ format, q: query, result });
      const expectedUserId = user?.id;
      let response;
      try { response = await fetch(new URL(`audit/export?${params}`, apiBase), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(25000) }); }
      catch { throw new ApiError('日志导出暂时连接失败，请稍后重试。', 0, 'NETWORK'); }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) { await forget(); globalThis.dispatchEvent?.(new Event('fengwei:login-required')); }
        throw new ApiError(data.error || '日志导出未完成，请重试。', response.status, data.code);
      }
      const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') || '')?.[1];
      const filename = encodedName ? decodeURIComponent(encodedName) : `峰味-操作日志.${format}`;
      const blob = await response.blob();
      if (user?.id !== expectedUserId) throw new ApiError('账号已切换，日志导出已取消。', 409, 'ACCOUNT_CHANGED');
      return { blob, filename, count: Number(response.headers.get('x-audit-count') || 0) };
    },
    async activity(action, recipeId) { if (offline || !authenticated) return; await request('activity', { method: 'POST', value: { action, ...(recipeId ? { recipeId } : {}) } }); },
    async history(id) {
      ensureOnline(); const data = await request(`history/${encodeURIComponent(id)}`); await sameAccount(data);
      await loadPhotos(data.items);
      return parallel(data.items, async item => ({ ...item, recipe: await hydrate(item) }));
    },
    async legacy() { return user?.legacy && local ? local.all() : []; },
    setting: key => local?.setting(`fengwei-user:${user?.id || ''}:${key}`),
    setSetting: (key, value) => local?.setSetting(`fengwei-user:${user?.id || ''}:${key}`, value),
  };
}
