import { createId, validateRecipe } from './store.js';
import { createOutbox } from './outbox.js';
import { deadline } from './runtime.js';
import { PHOTO_PACKET_TYPE, packPhotos, unpackPhotos, splitPhoto, joinPhoto } from './photo-wire.js';

const CACHE_KEY = 'fengwei-server-cache-v2';
const OLD_CACHE_KEY = 'fengwei-server-cache-v1';
const LOGOUT_KEY = 'fengwei-pending-logout';
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
export async function createRemoteStore(local, { requestTimeout = 25000 } = {}) {
  let cacheReadFailed = false;
  const [savedLogout, savedSnapshot] = await Promise.all([LOGOUT_KEY, CACHE_KEY].map(key => local?.setting(key).catch(() => { cacheReadFailed = true; return null; })));
  let pendingLogout = savedLogout || null;
  try { pendingLogout ||= JSON.parse(globalThis.localStorage?.getItem(LOGOUT_KEY) || 'null'); } catch {}
  let snapshot = savedSnapshot || null;
  if (pendingLogout) snapshot = null;
  if (!snapshot?.user?.id) snapshot = null;
  if (snapshot && !(Date.now() - snapshot.authenticatedAt < CACHE_AGE)) snapshot = null;
  let offline = false, authenticated = false, user = snapshot?.user || null;
  let records = snapshot?.recipes || [], revisions = Object.assign(Object.create(null), snapshot?.revisions || {});
  let hashes = Object.assign(Object.create(null), snapshot?.photoHashes || {}), conflicts = [];
  let photoVersion = snapshot?.photoVersion || '';
  const photoCache = new Map();
  for (const recipe of records) { const key = hashes[recipe.id]; if (key && recipe.photo) photoCache.set(key, recipe.photo); }
  let cacheWarning = !local || cacheReadFailed;
  let accountEpoch = 0, syncing = null, outbox = null;
  let dataEpoch = 0, mutationTail = Promise.resolve();
  function mutate(work) {
    const epoch = accountEpoch;
    dataEpoch++;
    const pending = mutationTail.then(() => {
      if (epoch !== accountEpoch) throw new ApiError('账号已切换，本次保存已取消。', 409, 'ACCOUNT_CHANGED');
      return work();
    });
    mutationTail = pending.catch(() => {});
    return pending;
  }
  const photoLoads = new Map();
  let batchPhotos = true, photoReferences = false, binaryPhotos = false;
  const apiBase = new URL('./api/', import.meta.url);
  function resetMemory() {
    outbox?.close(); outbox = null;
    accountEpoch++; photoLoads.clear(); photoReferences = false; binaryPhotos = false;
    snapshot = null; records = []; revisions = Object.create(null); hashes = Object.create(null);
    conflicts = []; photoCache.clear(); user = null; authenticated = false; offline = false;
  }
  async function forget(clearLocal = true) {
    const previousId = user?.id;
    resetMemory();
    if (clearLocal && local) {
      try { await Promise.all([local.setSetting(CACHE_KEY, null), local.setSetting(OLD_CACHE_KEY, null), ...(previousId ? [local.setSetting(`fengwei-user:${previousId}:pendingWrites`, null)] : [])]); }
      catch { cacheWarning = true; return false; }
    }
    return true;
  }
  async function acceptUser(nextUser) {
    if (!nextUser?.id || !nextUser.displayName) throw new ApiError('服务器账号接口未就绪，请部署完整新版。', 503, 'INVALID_ACCOUNT');
    if (user?.id !== nextUser.id) await forget();
    user = nextUser;
    await openOutbox();
  }
  async function request(path, { method = 'GET', value, binary, receivePhotos = false, retrySafe = false } = {}) {
    const epoch = accountEpoch;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response, data;
      const controller = new AbortController();
      try {
        await deadline((async () => {
          response = await fetch(new URL(path, apiBase), { method, credentials: 'same-origin', cache: 'no-store', headers: { ...(receivePhotos ? { Accept: PHOTO_PACKET_TYPE } : {}), ...(binary ? { 'Content-Type': PHOTO_PACKET_TYPE } : value === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(binary ? { body: binary } : value === undefined ? {} : { body: JSON.stringify(value) }), signal: controller.signal });
          try {
            if (response.ok && response.headers.get('content-type') === PHOTO_PACKET_TYPE) {
              const packet = unpackPhotos(await response.arrayBuffer()); data = packet.metadata;
              if (Array.isArray(data.hashes)) {
                if (data.hashes.length !== packet.photos.length) throw new Error('Photo count mismatch');
                data.photos = Object.fromEntries(data.hashes.map((hash, i) => [hash, joinPhoto(packet.photos[i])]));
              } else data.photo = joinPhoto(packet.photos[0]);
            } else data = await response.json();
          } catch { throw new ApiError('未收到完整结果，请重试以确认保存状态。', response.status, 'INVALID_RESPONSE'); }
        })(), method === 'GET' && (path === 'me' || path.startsWith('recipes')) ? Math.min(requestTimeout, 12000) : requestTimeout, '服务器响应超时，请重试。', () => controller.abort());
      } catch (error) {
        controller.abort();
        if (retrySafe && attempt < 2 && epoch === accountEpoch) continue;
        if (error.code === 'INVALID_RESPONSE') throw error;
        throw new ApiError(retrySafe ? '尚未确认保存结果，内容已保留。请联网后再次保存，将先核实上次结果。' : '服务器暂时连不上。缓存仍可查看，修改需要联网后再保存。', 0, 'NETWORK');
      }
      if (epoch !== accountEpoch) throw new ApiError('账号已切换，本次请求已取消。', 409, 'ACCOUNT_CHANGED');
      // Retries preserve the exact registration/mutation ID. These errors occur
      // before the platform's request body is available for a server mutation.
      if (response.status === 400 && ['EMPTY_BODY', 'BODY_UNREADABLE'].includes(data.code) && attempt < 2) continue;
      if (retrySafe && response.status >= 500 && attempt < 2) continue;
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
    snapshot = { user, recipes: records, revisions, photoHashes: hashes, photoVersion, authenticatedAt: Date.now() };
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
          const loading = request(`photo/${key}`, { receivePhotos: binaryPhotos }).then(async data => { await sameAccount(data); photoCache.set(key, data.photo); return data.photo; }).finally(() => { if (photoLoads.get(key) === loading) photoLoads.delete(key); });
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
        try { data = await request('photos', { method: 'POST', value: { hashes: pending }, receivePhotos: binaryPhotos }); }
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
  async function markLogout(value) {
    pendingLogout = value;
    try { if (value) globalThis.localStorage?.setItem(LOGOUT_KEY, JSON.stringify(value)); else globalThis.localStorage?.removeItem(LOGOUT_KEY); } catch { cacheWarning = true; }
    try { await local?.setSetting(LOGOUT_KEY, value); } catch { cacheWarning = true; }
  }
  let logoutInFlight = null;
  function finishLogout() {
    if (logoutInFlight) return logoutInFlight;
    if (!pendingLogout) return Promise.resolve();
    const value = pendingLogout;
    const job = (async () => {
      try { await request('logout', { method: 'POST', value, retrySafe: true }); }
      catch (error) { if (error.code !== 'ACCOUNT_CHANGED') throw error; }
      if (pendingLogout === value) await markLogout(null);
    })().finally(() => { if (logoutInFlight === job) logoutInFlight = null; });
    logoutInFlight = job; return job;
  }
  const uncertain = error => ['NETWORK', 'INVALID_RESPONSE', 'STORAGE_UNAVAILABLE'].includes(error.code) || error.status >= 500;
  const pendingWrites = new Map();
  const content = recipe => recipe ? JSON.stringify({ ...recipe, updatedAt: '', favorite: false }) : 'deleted';
  async function sendWrite(id, pending) {
    const { value, recipe, method } = pending;
    const binary = pending.binary ? packPhotos({ ...value, recipe: { ...value.recipe, photo: '' } }, [splitPhoto(recipe.photo)]) : undefined;
    const data = await request(`recipe/${encodeURIComponent(id)}`, { method, value, binary, retrySafe: true });
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
    return item;
  }
  async function writeNow(id, recipe, method = 'PUT', options = {}) {
    ensureOnline();
    const valid = recipe ? validateRecipe(recipe) : null;
    const owner = user?.id, key = `fengwei-user:${owner}:pendingWrites`;
    let pending = pendingWrites.get(owner);
    if (!pending) { pending = Object.assign(Object.create(null), await local?.setting(key).catch(() => null) || {}); pendingWrites.set(owner, pending); }
    const remember = async () => { try { await local?.setSetting(key, structuredClone(pending)); } catch { cacheWarning = true; } };
    if (pending[id]) {
      const previous = pending[id];
      let confirmed;
      try { confirmed = await sendWrite(id, previous); }
      catch (error) { if (!uncertain(error)) { delete pending[id]; await remember(); } throw error; }
      delete pending[id]; await remember();
      if (previous.method === method && content(previous.recipe) === content(valid)) return;
      // Only advance this editor's base when its own uncertain write was confirmed.
      if (!Object.hasOwn(options, 'baseRevision') || options.baseRevision === previous.value.baseRevision) options = { ...options, baseRevision: confirmed.revision };
    }
    const reused = photoReferences && valid?.photo && hashes[id] && photoCache.get(hashes[id]) === valid.photo ? hashes[id] : '';
    const value = { ...(valid ? { recipe: { ...valid, photo: reused ? '' : valid.photo } } : {}), ...(reused ? { photoHash: reused } : {}), expectedUserId: user?.id, baseRevision: Object.hasOwn(options, 'baseRevision') ? options.baseRevision : revisions[id] || null, mutationId: createId(), ...(options.operation ? { operation: options.operation } : {}) };
    pending[id] = { value, recipe: valid, method, binary: !!(binaryPhotos && valid?.photo && !reused) }; await remember();
    try { await sendWrite(id, pending[id]); }
    catch (error) { if (!uncertain(error)) { delete pending[id]; await remember(); } throw error; }
    delete pending[id]; await remember();
  }
  function notifyQueue() { globalThis.dispatchEvent?.(new Event('fengwei:queue-changed')); }
  async function openOutbox() {
    if (outbox || !user?.id) return;
    const owner = user.id;
    outbox = createOutbox({ local, owner, changed: notifyQueue, committed: () => globalThis.dispatchEvent?.(new Event('fengwei:sync-complete')),
      ready: () => authenticated && user?.id === owner && !pendingLogout && globalThis.navigator?.onLine !== false,
      send: job => mutate(async () => {
        if (user?.id !== owner) throw new ApiError('请登录原账号继续同步。', 409, 'ACCOUNT_CHANGED');
        if (job.kind === 'recipe') return sendWrite(job.id, job);
        const data = await request(`favorite/${encodeURIComponent(job.id)}`, { method: 'PUT', value: job.value, retrySafe: true });
        await sameAccount(data);
        records = records.map(recipe => recipe.id === job.id ? { ...recipe, favorite: data.favorite } : recipe);
        await persist();
      }),
    });
    await outbox.reload().catch(() => { cacheWarning = true; });
  }
  function current() {
    const result = new Map(records.map(recipe => [recipe.id, recipe]));
    for (const job of outbox?.jobs || []) {
      if (job.kind === 'recipe') result.set(job.id, { ...job.recipe, favorite: result.get(job.id)?.favorite ?? job.recipe.favorite });
      else if (result.has(job.id)) result.set(job.id, { ...result.get(job.id), favorite: job.value.favorite });
    }
    return [...result.values()];
  }
  function localRevision(id) {
    const job = outbox?.jobs.filter(item => item.id === id && item.kind === 'recipe').at(-1);
    return job ? `local:${job.token}` : revisions[id] || null;
  }
  async function enqueue(kind, id, recipe, favorite, options = {}) {
    if (!authenticated || !user) throw new ApiError('请先登录后保存。', 401, 'LOGIN_REQUIRED');
    if (kind === 'recipe' && !user.canEdit) throw new ApiError('请先申请编辑权限。', 403, 'EDIT_PERMISSION_REQUIRED');
    const owner = user.id; await openOutbox();
    const token = createId(), valid = recipe ? validateRecipe(recipe) : null;
    const baseRevision = Object.hasOwn(options, 'baseRevision') ? options.baseRevision : localRevision(id);
    const value = { expectedUserId: owner, mutationId: token, ...(valid ? { recipe: valid, baseRevision } : { favorite: !!favorite }) };
    await outbox.enqueue({ token, kind, id, title: valid?.title || current().find(item => item.id === id)?.title || '菜谱收藏', value, recipe: valid, method: 'PUT', binary: !!(binaryPhotos && valid?.photo) });
    if (owner !== user?.id) throw new ApiError('账号已切换，内容保留在原账号的同步任务中。', 409, 'ACCOUNT_CHANGED');
  }
  function requireSettled(id) {
    if (outbox?.jobs.some(job => !id || job.id === id)) throw new ApiError('本机还有待同步或失败的修改，请先在“后台同步”中处理。', 409, 'PENDING_SYNC');
  }
  const write = (...args) => { requireSettled(args[0]); return mutate(() => writeNow(...args)); };
  const setFavorite = (...args) => { requireSettled(args[0]); return mutate(() => setFavoriteNow(...args)); };
  async function setFavoriteNow(id, favorite) {
    ensureOnline();
    const data = await request(`favorite/${encodeURIComponent(id)}`, { method: 'PUT', value: { favorite, expectedUserId: user?.id, mutationId: createId() } });
    await sameAccount(data);
    records = records.map(recipe => recipe.id === id ? { ...recipe, favorite: data.favorite } : recipe);
    await persist();
  }
  async function synchronize(job) {
    await mutationTail;
    if (pendingLogout) { await finishLogout().catch(() => {}); throw new ApiError('已退出，请重新登录。', 401, 'LOGIN_REQUIRED'); }
    const version = dataEpoch;
    try {
      const next = [], newRevisions = Object.create(null), newHashes = Object.create(null), newConflicts = [];
      let cursor = null, first = true;
      do {
        const data = await request(`recipes${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
        if (first) {
          const principal = data.user || (await request('me')).user;
          if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
          if (job.expectedUserId && principal?.id !== job.expectedUserId) throw new ApiError('账号已切换，请重新登录后生成备份。', 409, 'ACCOUNT_CHANGED');
          await acceptUser(principal); job.epoch = accountEpoch; first = false;
        }
        await sameAccount(data);
        photoReferences = data.capabilities?.photoReferences === true;
        binaryPhotos = data.capabilities?.binaryPhotos === true;
        if ((data.capabilities?.photoVersion || '') !== photoVersion) {
          photoCache.clear(); photoVersion = data.capabilities?.photoVersion || '';
        }
        await loadPhotos(data.items);
        const hydrated = await parallel(data.items, hydrate);
        if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
        // A save/favorite may have completed while this response was in flight.
        // Wait for all queued mutations, then fetch a fresh snapshot.
        if (version !== dataEpoch) return synchronize(job);
        for (let i = 0; i < data.items.length; i++) {
          const item = data.items[i]; newRevisions[item.id] = item.revision; newHashes[item.id] = item.photoHash;
          if (item.conflictCount > 1) newConflicts.push(item.id); if (hydrated[i]) next.push(hydrated[i]);
        }
        cursor = data.cursor;
      } while (cursor);
      records = next; revisions = newRevisions; hashes = newHashes; conflicts = newConflicts;
      offline = false; authenticated = true; await persist(); await outbox?.reload(); if (local) await outbox?.authorize(); outbox?.drain().catch(() => {}); return current();
    } catch (error) {
      if (error.status === 401) throw error;
      if (job.epoch !== accountEpoch) throw new ApiError('账号已切换，本次同步已取消。', 409, 'ACCOUNT_CHANGED');
      if (version !== dataEpoch) return synchronize(job);
      if (!job.requireOnline && (error.code === 'NETWORK' || error.code === 'STORAGE_UNAVAILABLE') && snapshot?.user && Date.now() - snapshot.authenticatedAt < CACHE_AGE) { offline = true; authenticated = true; await openOutbox(); return current(); }
      throw error;
    }
  }
  await openOutbox();
  return {
    get user() { return user; },
    get readOnly() { return offline; },
    get canEdit() { return authenticated && !offline && !!user?.canEdit; },
    get authenticated() { return authenticated; },
    get conflicts() { return conflicts; },
    get cacheWarning() { return cacheWarning; },
    get pendingLogout() { return !!pendingLogout; },
    completeLogout: finishLogout,
    current,
    revision: localRevision,
    get syncJobs() { return outbox?.jobs || []; },
    queuePut: (recipe, options) => enqueue('recipe', recipe.id, recipe, null, options),
    queueFavorite: (id, favorite) => enqueue('favorite', id, null, favorite),
    async retrySync() { await openOutbox(); await outbox?.retry(); },
    async resumeSync() { await openOutbox(); await outbox?.reload(); await outbox?.drain(); },
    async discardSync(token) { await outbox?.discard(token); },
    all() {
      if (syncing?.epoch === accountEpoch) return syncing.promise;
      const job = { epoch: accountEpoch };
      job.promise = synchronize(job).finally(() => { if (syncing === job) syncing = null; }); syncing = job;
      return job.promise;
    },
    async fullBackupRequest(action, value) {
      await outbox?.reload(); requireSettled();
      const expectedUserId = user?.id;
      if (user?.role !== 'admin') throw new ApiError('只有管理员可以生成完整备份。', 403, 'ADMIN_REQUIRED');
      const data = await request(`admin/backup/${action}`, { method: 'POST', value: { ...value, expectedUserId } });
      await sameAccount(data); return data;
    },
    async backupSnapshot() {
      await outbox?.reload(); requireSettled();
      const epoch = accountEpoch, expectedUserId = user?.id;
      if (!expectedUserId) throw new ApiError('请先登录后生成备份。', 401, 'LOGIN_REQUIRED');
      const checkAccount = () => {
        if (epoch !== accountEpoch || user?.id !== expectedUserId) throw new ApiError('账号已切换，备份已取消。', 409, 'ACCOUNT_CHANGED');
      };
      // An already-running sync may have started before the export click.
      // Wait for it, then fetch every page again with cache fallback disabled.
      if (syncing) await syncing.promise.catch(() => {});
      checkAccount();
      const job = { epoch, expectedUserId, requireOnline: true };
      job.promise = synchronize(job).finally(() => { if (syncing === job) syncing = null; }); syncing = job;
      const latest = await job.promise;
      checkAccount(); await outbox?.reload(); requireSettled();
      return { recipes: structuredClone(latest), userId: expectedUserId, syncedAt: new Date().toISOString() };
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
      if (pendingLogout) await finishLogout();
      const data = await request('login', { method: 'POST', value: { username, password } });
      accountEpoch++;
      await acceptUser(data.user); offline = false; authenticated = true;
    },
    async register(displayName, password, registrationId) {
      if (pendingLogout) await finishLogout();
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
    async logout(all = false) {
      if (all) { ensureOnline(); await request('logout', { method: 'POST', value: { all: true, expectedUserId: user?.id }, retrySafe: true }); }
      const owner = user?.id;
      await markLogout({ expectedUserId: owner });
      pendingWrites.delete(owner);
      const cleared = await forget();
      if (all) await markLogout(null);
      else if (globalThis.navigator?.onLine !== false) finishLogout().catch(() => {});
      return cleared;
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
    async deleteAccounts(value) { ensureOnline(); const data = await request('accounts/delete', { method: 'POST', value: { ...value, expectedUserId: user?.id } }); await sameAccount(data); return data; },
    async photoInventory(cursor = '') { ensureOnline(); const data = await request(`admin/photos?cursor=${encodeURIComponent(cursor)}`); await sameAccount(data); return data; },
    async image(hash) { ensureOnline(); const data = await request(`photo/${hash}`, { receivePhotos: true }); await sameAccount(data); return data.photo; },
    optimizeImage(hash, photo) {
      return mutate(async () => {
        ensureOnline(); const binary = packPhotos({ expectedUserId: user?.id }, [splitPhoto(photo)]);
        const data = await request(`admin/photos/${hash}`, { method: 'PUT', binary }); await sameAccount(data);
        photoCache.clear(); return data.result;
      });
    },
    async audit({ cursor = '', query = '', result = '', from = '', to = '' } = {}) {
      ensureOnline(); const params = new URLSearchParams({ cursor, q: query, result, from, to });
      const data = await request(`audit?${params}`); await sameAccount(data); return data;
    },
    async retention() { const data = await request('admin/audit-retention'); await sameAccount(data); return data.retention; },
    async cleanAudit() { ensureOnline(); return request('maintenance/audit', { method: 'POST', value: {} }); },
    async purgeRecipe(id, baseRevision, mutationId) {
      requireSettled(id); ensureOnline();
      const data = await request(`trash/${encodeURIComponent(id)}`, { method: 'DELETE', value: { baseRevision, mutationId, expectedUserId: user?.id }, retrySafe: true });
      await sameAccount(data); return data;
    },
    async trash(cursor = '') { ensureOnline(); const data = await request(`trash?cursor=${encodeURIComponent(cursor)}`); await sameAccount(data); return data; },
    async exportAudit(format, { query = '', result = '', from = '', to = '' } = {}) {
      ensureOnline(); const params = new URLSearchParams({ format, q: query, result, from, to });
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
    async history(id, revision) {
      ensureOnline(); const data = await request(`history/${encodeURIComponent(id)}${revision ? `?revision=${encodeURIComponent(revision)}` : ''}`); await sameAccount(data);
      await loadPhotos(data.items);
      return parallel(data.items, async item => ({ ...item, recipe: await hydrate(item) }));
    },
    async legacy() { return user?.legacy && local ? local.all() : []; },
    setting: key => local?.setting(`fengwei-user:${user?.id || ''}:${key}`),
    setSetting: (key, value) => local?.setSetting(`fengwei-user:${user?.id || ''}:${key}`, value),
  };
}
