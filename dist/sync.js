import { createId, validateRecipe } from './store.js';

const CACHE_KEY = 'fengwei-server-cache-v2';
const OLD_CACHE_KEY = 'fengwei-server-cache-v1';
const CACHE_AGE = 90 * 24 * 3600 * 1000;
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
  const apiBase = new URL('./api/', import.meta.url);
  function resetMemory() {
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
      if (!photo) { photo = (await request(`photo/${item.photoHash}`)).photo; photoCache.set(item.photoHash, photo); }
    }
    return validateRecipe({ ...item.recipe, photo });
  }
  function ensureOnline() {
    if (offline || globalThis.navigator?.onLine === false) throw new ApiError('当前为离线预览，修改还没有保存。联网后请先同步，再保存。', 0, 'OFFLINE');
  }
  async function write(id, recipe, method = 'PUT', options = {}) {
    ensureOnline();
    const data = await request(`recipe/${encodeURIComponent(id)}`, { method, value: { ...(recipe ? { recipe: validateRecipe(recipe) } : {}), baseRevision: Object.hasOwn(options, 'baseRevision') ? options.baseRevision : revisions[id] || null, mutationId: createId(), ...(options.operation ? { operation: options.operation } : {}) } });
    await sameAccount(data);
    const item = data.item;
    revisions[id] = item.revision; hashes[id] = item.photoHash;
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
  return {
    get user() { return user; },
    get readOnly() { return offline; },
    get canEdit() { return !offline && !!user?.canEdit; },
    get authenticated() { return authenticated; },
    get conflicts() { return conflicts; },
    get cacheWarning() { return cacheWarning; },
    revision: id => revisions[id] || null,
    async all() {
      try {
        await acceptUser((await request('me')).user);
        const next = [], newRevisions = Object.create(null), newHashes = Object.create(null), newConflicts = [];
        let cursor = null;
        do {
          const data = await request(`recipes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
          await sameAccount(data);
          for (const item of data.items) { newRevisions[item.id] = item.revision; newHashes[item.id] = item.photoHash; if (item.conflictCount > 1) newConflicts.push(item.id); const recipe = await hydrate(item); if (recipe) next.push(recipe); }
          cursor = data.cursor;
        } while (cursor);
        records = next; revisions = newRevisions; hashes = newHashes; conflicts = newConflicts;
        offline = false; authenticated = true; await persist(); return records;
      } catch (error) {
        if ((error.code === 'NETWORK' || error.code === 'STORAGE_UNAVAILABLE') && snapshot?.user && Date.now() - snapshot.authenticatedAt < CACHE_AGE) {
          offline = true; authenticated = true; return records;
        }
        throw error;
      }
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
    async login(username, password) {
      const data = await request('login', { method: 'POST', value: { username, password } });
      await acceptUser(data.user); offline = false; authenticated = true;
    },
    async register(displayName, password, registrationId) {
      const data = await request('register', { method: 'POST', value: { displayName, password, registrationId } });
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
    async requestPermission(reason, requestId) { ensureOnline(); return request('permissions/request', { method: 'POST', value: { reason, requestId } }); },
    async decidePermission(value) { ensureOnline(); return request('permissions/decision', { method: 'POST', value }); },
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
      const result = [];
      for (const item of data.items) result.push({ ...item, recipe: await hydrate(item) });
      return result;
    },
    async legacy() { return user?.legacy && local ? local.all() : []; },
    setting: key => local?.setting(`fengwei-user:${user?.id || ''}:${key}`),
    setSetting: (key, value) => local?.setSetting(`fengwei-user:${user?.id || ''}:${key}`, value),
  };
}
