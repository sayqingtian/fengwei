import { hash, RecipeDatabase } from './database.mjs';
import { validateRecipe } from '../dist/store.js';
import { createAuth, testAccount, sessionCookie } from './auth.mjs';
import { readJsonBody as body } from './json-body.mjs';
import { publicUser, requireUniqueWrites } from './accounts.mjs';
import { Favorites } from './favorites.mjs';
import { AuditLog } from './audit.mjs';
import { makeAuditExport } from './audit-export.mjs';
import { PasswordRecovery, RECOVERY_MESSAGE } from './password-recovery.mjs';
import { requestStore } from './request-store.mjs';
import { RateLimits } from './rate-limit.mjs';

const publicEvent = (event, favorite) => event && ({ id: event.id, revision: event.revision, deleted: event.deleted, photoHash: event.photoHash, recipe: event.recipe ? { ...event.recipe, favorite: !!favorite } : null, savedAt: event.savedAt, conflictCount: event.conflictCount || 1 });
class HttpError extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff', ...extraHeaders } });
}
function writableOrigin(request) {
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(request.url).origin)) fail(403, 'BAD_ORIGIN', '请从峰味自己的网址操作。');
}
function mutation(data) {
  if (!data || typeof data !== 'object' || !/^[a-zA-Z0-9-]{8,128}$/.test(data.mutationId || '') || !Object.hasOwn(data, 'baseRevision')) fail(400, 'INVALID_MUTATION', '保存请求缺少版本信息，请刷新后重试。');
}
function auditDates(params) {
  const dates = {};
  for (const key of ['from', 'to']) {
    const value = params.get(key) || '';
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value)) fail(400, 'INVALID_FILTER', '请选择有效的日志日期。');
    dates[key] = value ? new Date(Date.parse(value + 'T00:00:00+08:00') + (key === 'to' ? 86400000 : 0)).toISOString() : '';
  }
  if (dates.from && dates.to && dates.from >= dates.to) fail(400, 'INVALID_FILTER', '结束日期不能早于开始日期。');
  return dates;
}
export function createApi({ database, password }) {
  const limits = new RateLimits(database.store);
  const store = requestStore(database.store);
  database = new RecipeDatabase(store);
  const auth = password === undefined ? createAuth(database?.store) : createAuth(database?.store, testAccount(password));
  const favorites = new Favorites(database.store, auth.accounts.legacyId);
  const audit = new AuditLog(database.store), permissions = auth.permissions;
  const recovery = new PasswordRecovery(auth.accounts, permissions.adminId);
  return (request, context = {}) => store.run(async () => {
    const address = context.clientIp ?? request.headers.get('x-real-ip') ?? 'local';
    const started = performance.now();
    let renewedCookie, actor, action, target = '', operationId;
    const receipt = () => audit.entry(actor, action, { target, operationId });
    const record = async result => {
      try { await audit.record(actor, action, { target, operationId, result }); }
      catch (error) { console.error('Fengwei audit index unavailable:', error.code || error.name); }
    };
    const reply = (value, status = 200, headers = {}) => json(value, status, { 'Server-Timing': `app;dur=${(performance.now() - started).toFixed(1)}`, ...(renewedCookie ? { 'Set-Cookie': renewedCookie } : {}), ...headers });
    try {
      if (!auth.configured) fail(503, 'NOT_CONFIGURED', '服务器账号尚未完成配置，请重新部署完整的峰味上传包。');
      const url = new URL(request.url), route = url.pathname.replace(/^.*?\/api\//, ''), method = request.method;
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'HTTPS_REQUIRED', '请通过 HTTPS 正式网址使用私人菜谱本。');
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式。');
      if (method !== 'GET') writableOrigin(request);
      if (route === 'health' && method === 'GET') {
        // No accounts or credentials are returned or created. This uses the
        // same bounded capability check required before every registration.
        try { await requireUniqueWrites(database.store); }
        catch (error) {
          console.error('Fengwei registration storage unavailable:', error.code || error.name);
          const code = /^(UNIQUE_STORAGE_UNAVAILABLE|ACCOUNT_DATABASE_(NOT_CONFIGURED|INVALID_CONFIG|CONNECTION_FAILED|AUTH_FAILED|SCHEMA_REQUIRED|UNAVAILABLE|CHANGED|UNSUPPORTED_KEY))$/.test(error.code || '') ? error.code : 'STORAGE_UNAVAILABLE';
          return reply({ ok: false, registration: false, code }, 503);
        }
        return reply({ ok: true, registration: true });
      }
      if (route === 'login' && method === 'POST') {
        action = 'account.login';
        const data = await body(request, 4096);
        actor = { displayName: typeof data?.username === 'string' ? data.username.trim().slice(0, 64) : '未登录用户' };
        await limits.consume('login', address, 10, 300000, 'TRY_LATER', '尝试次数较多，请 5 分钟后再试。');
        const user = await auth.accounts.authenticate(data?.username, data?.password);
        if (!user) {
          fail(401, 'BAD_CREDENTIALS', '账号或密码不正确。');
        }
        const [profile, token] = await Promise.all([permissions.profile(user), auth.issue(user)]);
        actor = publicUser(profile);
        await record('success');
        return reply({ ok: true, user: actor }, 200, { 'Set-Cookie': sessionCookie(request, token) });
      }
      if (route === 'register' && method === 'POST') {
        action = 'account.register';
        const data = await body(request, 4096);
        actor = { displayName: typeof data?.displayName === 'string' ? data.displayName.trim().slice(0, 30) : '未登录用户' };
        await limits.consume('register', address, 20, 3600000, 'REGISTER_LATER', '注册次数较多，请稍后再试。');
        const user = await auth.accounts.register(data);
        actor = publicUser(await permissions.profile(user)); operationId = data.registrationId;
        await record('success');
        return reply({ ok: true, user: actor }, 201, { 'Set-Cookie': sessionCookie(request, await auth.issue(user)) });
      }
      if (route === 'account/recovery' && method === 'POST') {
        action = 'account.recovery.request'; target = '密码找回申请';
        await limits.consume('recovery', address, 5, 900000, 'RECOVERY_TRY_LATER', '找回申请次数较多，请 15 分钟后再试。');
        const data = await body(request, 4096); operationId = data?.requestId;
        await recovery.request(data, receipt()); await record('success');
        return reply({ ok: true, message: RECOVERY_MESSAGE });
      }
      const session = await auth.verify(request);
      if (!session) fail(401, 'LOGIN_REQUIRED', '请先输入账号和密码，打开你的私人菜谱本。');
      if (session.renew) renewedCookie = sessionCookie(request, await auth.issue(session.account));
      const user = session.user;
      actor = user;
      if (route === 'logout' && method === 'POST') {
        action = 'account.logout'; await record('success');
        return reply({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
      }
      if (route === 'me' && method === 'GET') return reply({ user });
      if (route === 'admin/password-recovery' && method === 'GET') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有管理员可以查看密码找回申请。');
        return reply({ userId: user.id, requests: await recovery.requests() });
      }
      if (route === 'admin/password-recovery/decision' && method === 'POST') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有管理员可以处理密码找回申请。');
        const data = await body(request, 4096);
        if (data?.expectedUserId && data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已在其他页面切换，请重新登录后操作。');
        action = data?.action === 'reject' ? 'account.recovery.reject' : 'account.recovery.reset';
        operationId = data?.mutationId;
        target = typeof data?.userId === 'string' ? data.userId : '';
        const item = await recovery.decide(user, data, receipt()); target = item.displayName;
        if (item.status === 'rejected') await record('success');
        if (item.userId === user.id && item.status === 'reset') {
          const account = await auth.accounts.get(user.id);
          return reply({ userId: user.id, user: publicUser(await permissions.profile(account)), item }, 200, { 'Set-Cookie': sessionCookie(request, await auth.issue(account)) });
        }
        return reply({ userId: user.id, item });
      }
      if (route === 'accounts/delete' && method === 'POST') {
        action = 'account.delete';
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有 wupanfeng 管理员可以删除账号。');
        const data = await body(request, 8192);
        if (data?.expectedUserId && data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请刷新后重试。');
        const targets = await auth.accounts.deletionTargets(data);
        const deletedIds = [];
        for (const account of targets) {
          target = `${account.displayName} · ${account.id}`;
          operationId = `${data.mutationId}:${account.id}`;
          try { await auth.accounts.deleteAccount(account, user, data.mutationId, receipt()); }
          catch { fail(503, 'ACCOUNT_DELETE_PARTIAL', `已确认删除 ${deletedIds.length} 个账号，其余账号暂未确认删除。请刷新账号列表后重试。`); }
          deletedIds.push(account.id);
          await record('success');
        }
        action = undefined;
        return reply({ ok: true, deletedIds });
      }
      if (route === 'account/password' && method === 'POST') {
        action = 'account.password'; target = '本人账号';
        await limits.consume('password', user.id, 10, 300000, 'PASSWORD_TRY_LATER', '密码修改尝试次数较多，请 5 分钟后再试。');
        const data = await body(request, 4096); operationId = data?.mutationId;
        const account = await auth.accounts.changePassword(user.id, data, session.account.passwordVersion || 'initial', receipt());
        return reply({ ok: true, userId: user.id, user: publicUser(await permissions.profile(account)) }, 200, { 'Set-Cookie': sessionCookie(request, await auth.issue(account)) });
      }
      if (route === 'permissions' && method === 'GET') {
        const admin = user.role === 'admin';
        const requests = await permissions.requests(admin ? undefined : user.id);
        const accounts = admin ? await Promise.all((await auth.accounts.list()).map(async item => publicUser(await permissions.profile(item)))) : undefined;
        return reply({ userId: user.id, user, requests, ...(admin ? { accounts } : {}) });
      }
      if (route === 'permissions/request' && method === 'POST') {
        action = 'permission.request';
        const data = await body(request, 4096); operationId = data?.requestId;
        target = typeof data?.reason === 'string' ? data.reason.trim() : '';
        const item = await permissions.request(user, data, receipt());
        return reply({ userId: user.id, item: { ...item, auditEntry: undefined } }, 201);
      }
      if (route === 'permissions/decision' && method === 'POST') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有 wupanfeng 管理员可以处理授权。');
        const data = await body(request, 4096);
        const account = await auth.accounts.get(data?.userId);
        if (!account) fail(404, 'ACCOUNT_NOT_FOUND', '账号不存在。');
        action = `permission.${data.action}`; operationId = data.mutationId; target = account.displayName;
        await permissions.decide(user, account, data, receipt());
        const [profile, requests] = await Promise.all([permissions.profile(account), permissions.requests(account.id)]);
        return reply({ userId: user.id, account: publicUser(profile), requests });
      }
      if (['audit', 'audit/export'].includes(route) && method === 'GET') {
        if (route === 'audit/export') { action = 'audit.export'; target = '操作日志'; }
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有 wupanfeng 管理员可以查看操作日志。');
        const cursor = url.searchParams.get('cursor') || '', query = url.searchParams.get('q') || '', result = url.searchParams.get('result') || '';
        const dates = auditDates(url.searchParams);
        if (cursor && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\|[a-f0-9]{64}$/.test(cursor)) fail(400, 'INVALID_FILTER', '日志分页位置不正确。');
        if (query.length > 100 || cursor.length > 100 || !['', 'success', 'denied', 'failed'].includes(result)) fail(400, 'INVALID_FILTER', '日志筛选条件不正确。');
        if (route === 'audit/export') {
          action = 'audit.export';
          const format = url.searchParams.get('format') || 'csv';
          if (!['csv', 'json'].includes(format)) fail(400, 'INVALID_EXPORT_FORMAT', '请选择 CSV 或 JSON 导出格式。');
          const file = makeAuditExport(await audit.filtered({ query, result, ...dates }), { format, query, result, from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '' });
          if (Buffer.byteLength(file.content) > 5 * 1024 * 1024) fail(413, 'AUDIT_EXPORT_TOO_LARGE', '导出文件较大，请缩小日期范围后分批导出。');
          target = `${format.toUpperCase()} · 共 ${file.count} 条记录`; await record('success');
          return new Response(file.content, { headers: { 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="fengwei-operation-logs.${format}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`, 'Cache-Control': 'private, no-store, max-age=0', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff', 'X-Audit-Count': String(file.count), ...(renewedCookie ? { 'Set-Cookie': renewedCookie } : {}) } });
        }
        return reply({ userId: user.id, ...await audit.list({ cursor, query, result, ...dates }) });
      }
      if (route === 'activity' && method === 'POST') {
        const data = await body(request, 4096);
        if (!['recipe.view', 'recipe.cook', 'backup.export'].includes(data?.action)) fail(400, 'INVALID_ACTIVITY', '操作类型不正确。');
        action = data.action;
        if (action.startsWith('recipe.')) {
          if (typeof data.recipeId !== 'string' || !data.recipeId || data.recipeId.length > 128 || data.recipeId.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
          const item = await database.latest(data.recipeId);
          if (!item || item.deleted) fail(404, 'NOT_FOUND', '菜谱不存在。');
          target = item.recipe.title;
        } else target = '共享菜谱 JSON 备份';
        await record('success'); return reply({ ok: true });
      }
      if (route === 'recipes' && method === 'GET') {
        const cursor = url.searchParams.get('cursor') || '';
        if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) fail(400, 'INVALID_CURSOR', '分页位置不正确。');
        const [result, states] = await Promise.all([database.list(cursor), favorites.states(user.id)]);
        if (!cursor) { action = 'recipes.sync'; await record('success'); }
        return reply({ userId: user.id, user, capabilities: { photoReferences: true }, items: result.items.map(event => publicEvent(event, favorites.value(event, user.id, states))), cursor: result.cursor });
      }
      if (route.startsWith('photo/') && method === 'GET') {
        const photo = await database.photo(route.slice(6));
        if (!photo) fail(404, 'NOT_FOUND', '照片不存在。');
        return reply({ photo });
      }
      if (route === 'photos' && method === 'POST') {
        const data = await body(request, 4096);
        if (!Array.isArray(data?.hashes) || !data.hashes.length || data.hashes.length > 8 || data.hashes.some(key => !/^[a-f0-9]{64}$/.test(key))) fail(400, 'INVALID_PHOTOS', '照片读取请求不正确。');
        const hashes = [...new Set(data.hashes)], loaded = await Promise.all(hashes.map(key => database.photo(key)));
        if (loaded.some(photo => !photo)) fail(404, 'PHOTO_NOT_FOUND', '照片不存在，请重新同步菜谱。');
        const photos = {}, pending = []; let bytes = 0;
        for (let i = 0; i < hashes.length; i++) {
          const size = Buffer.byteLength(loaded[i]);
          if (bytes && bytes + size > 3 * 1024 * 1024) pending.push(hashes[i]);
          else { photos[hashes[i]] = loaded[i]; bytes += size; }
        }
        return reply({ userId: user.id, photos, pending });
      }
      if (route.startsWith('history/') && method === 'GET') {
        const id = decodeURIComponent(route.slice(8));
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const [states, history] = await Promise.all([favorites.states(user.id), database.history(id)]);
        action = 'recipe.history'; target = history[0]?.recipe?.title || id; await record('success');
        return reply({ userId: user.id, items: history.map(event => publicEvent(event, favorites.value(event, user.id, states))) });
      }
      if (route.startsWith('favorite/') && method === 'PUT') {
        action = 'recipe.favorite';
        const id = decodeURIComponent(route.slice(9));
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const data = await body(request, 4096);
        operationId = data?.mutationId;
        if (typeof data?.favorite !== 'boolean' || !/^[a-zA-Z0-9-]{8,128}$/.test(data?.mutationId || '')) fail(400, 'INVALID_FAVORITE', '收藏请求不完整，请重试。');
        if (data.expectedUserId && data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已在其他页面切换，请重新同步后操作。');
        const current = await database.latest(id);
        if (!current || current.deleted) fail(404, 'NOT_FOUND', '这道菜谱已不存在，请同步菜谱。');
        await favorites.preserveLegacy(current);
        await favorites.set(user.id, id, data.favorite, data.mutationId);
        target = `${current.recipe.title} · ${data.favorite ? '收藏' : '取消收藏'}`; await record('success');
        return reply({ userId: user.id, id, favorite: data.favorite });
      }
      if (route.startsWith('recipe/') && ['PUT', 'DELETE'].includes(method)) {
        action = method === 'DELETE' ? 'recipe.delete' : 'recipe.update';
        const id = decodeURIComponent(route.slice(7));
        target = id;
        if (!user.canEdit) fail(403, 'EDIT_PERMISSION_REQUIRED', '当前账号只有查看权限。请在“我的 → 账号授权”说明原因并申请编辑权限。');
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const data = await body(request); mutation(data);
        if (data.photoHash !== undefined && (method !== 'PUT' || typeof data.photoHash !== 'string' || !/^[a-f0-9]{64}$/.test(data.photoHash))) fail(400, 'INVALID_PHOTO', '照片版本不正确，请重新同步。');
        operationId = data.mutationId;
        let recipe = null;
        if (method === 'PUT') {
          try { recipe = validateRecipe(data.recipe); } catch (error) { fail(400, 'INVALID_RECIPE', error.message); }
          if (recipe.id !== id) fail(400, 'INVALID_ID', '菜谱编号不一致。');
          if (recipe.photo.length > 3 * 1024 * 1024 || Buffer.byteLength(JSON.stringify({ ...recipe, photo: '' }), 'utf8') > 150000) fail(413, 'TOO_LARGE', '菜谱文字或照片太大，请缩小内容后保存。');
          // Favorites are private account state, never part of a shared save.
          recipe.favorite = false;
        }
        const before = await database.latest(id);
        if (method === 'PUT') action = data.operation === 'import' ? 'recipe.import' : data.operation === 'restore' ? 'recipe.restore' : data.baseRevision === null ? 'recipe.create' : 'recipe.update';
        target = recipe?.title || before?.recipe?.title || id;
        await favorites.preserveLegacy(before);
        const event = await database.commit({ id, recipe, baseRevision: data.baseRevision, mutationId: data.mutationId, auditEntry: receipt(), photoHash: data.photoHash || '' });
        // The committed immutable event already contains the durable audit receipt.
        const [states, heads] = await Promise.all([favorites.states(user.id, id), database.headKeys(`recipes/${hash(id)}/`)]);
        return reply({ userId: user.id, item: publicEvent({ ...event, conflictCount: heads[0]?.[2] || 1 }, favorites.value(event, user.id, states)) });
      }
      fail(404, 'NOT_FOUND', '接口不存在，请确认已部署完整的峰味服务端。');
    } catch (error) {
      if (action) await record(error.status === 403 ? 'denied' : 'failed').catch(() => {});
      if (error.status) return reply({ error: error.message, code: error.code || 'REQUEST_FAILED' }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
      console.error('Fengwei storage error:', error.code || error.name);
      return json({ error: '服务器存储暂时不可用，数据尚未确认保存，请稍后重试。', code: 'STORAGE_UNAVAILABLE' }, 503);
    }
  });
}
