import { FullBackup, snapshotTime } from './full-backup.mjs';
import { AuditRetention } from './audit-retention.mjs';
import { hash, RecipeDatabase } from './database.mjs';
import { validateRecipe } from '../dist/store.js';
import { createAuth, testAccount, sessionCookie } from './auth.mjs';
import { readJsonBody as body, readBodyBytes } from './json-body.mjs';
import { PHOTO_PACKET_TYPE, packPhotos, unpackPhotos, joinPhoto } from '../dist/photo-wire.js';
import { publicUser, requireUniqueWrites } from './accounts.mjs';
import { Favorites } from './favorites.mjs';
import { AuditLog } from './audit.mjs';
import { makeAuditExport } from './audit-export.mjs';
import { PasswordRecovery, RECOVERY_MESSAGE } from './password-recovery.mjs';
import { requestStore } from './request-store.mjs';
import { CookingCheckins } from './checkins.mjs';
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
  const checkins = new CookingCheckins(database.store);
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
    const binaryReply = (bytes, type) => new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store, max-age=0', 'Vary': 'Cookie, Accept', 'X-Content-Type-Options': 'nosniff', 'Server-Timing': `app;dur=${(performance.now() - started).toFixed(1)}`, ...(renewedCookie ? { 'Set-Cookie': renewedCookie } : {}) } });
    const photoBody = async () => {
      try { return unpackPhotos(await readBodyBytes(request, 512 * 1024)); }
      catch (error) { if (error.status) throw error; fail(400, 'INVALID_PHOTO_PACKET', '照片上传不完整，请重试。'); }
    };
    try {
      const migration = await store.get('private/full-restore.json', { type: 'json', consistency: 'strong' });
      if (migration && !migration.complete) fail(503, 'MIGRATION_INCOMPLETE', '本站正在恢复完整备份，请等待迁移校验完成后再使用。');
      if (!auth.configured) fail(503, 'NOT_CONFIGURED', '服务器账号尚未完成配置，请重新部署完整的峰味上传包。');
      const url = new URL(request.url), route = url.pathname.replace(/^.*?\/api\//, ''), method = request.method;
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'HTTPS_REQUIRED', '请通过 HTTPS 正式网址使用私人菜谱本。');
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式。');
      if (method !== 'GET') writableOrigin(request);
      if (route === 'maintenance/audit' && method === 'POST') {
        // Fixed server policy only: no caller-controlled keys, dates or scope.
        await limits.consume('audit-maintenance', 'global', 1, 60000, 'TRY_LATER', '清理正在进行，请稍后重试。');
        const result = await new AuditRetention(store).run({ maxRecords: 2000, budgetMs: 15000 });
        return reply({ ok: true, complete: !!result.completedAt });
      }
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
      if (route === 'logout' && method === 'POST') {
        const data = await body(request, 4096);
        if (!session && data.all === true && !(await auth.verify(request, Date.now(), { allowRevoked: true }))?.allLogout) fail(401, 'LOGIN_REQUIRED', '请重新登录后再退出所有设备。');
        if (session && data.expectedUserId && data.expectedUserId !== session.user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请重新登录。');
        if (session) {
          actor = session.user; action = 'account.logout'; target = data.all === true ? '退出所有设备' : '退出当前设备';
          await auth.revoke(session, data.all === true); await record('success');
        }
        return reply({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
      }
      if (!session) fail(401, 'LOGIN_REQUIRED', '请先输入账号和密码，打开你的私人菜谱本。');
      if (session.renew) renewedCookie = sessionCookie(request, await auth.issue(session.account, undefined, session));
      const user = session.user;
      actor = user;
      if (route === 'me' && method === 'GET') return reply({ user });
      if (route === 'checkins' && method === 'GET') return reply({ userId: user.id, ...await checkins.list(user.id, url.searchParams.get('cursor') || '') });
      if (route.startsWith('checkins/') && method === 'DELETE') {
        const data = await body(request, 2048), id = route.slice(9);
        if (data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请重新操作。');
        action = 'recipe.checkin.delete'; operationId = id; target = '删除自己的打卡';
        return reply({ userId: user.id, ...await checkins.remove(user.id, id, receipt()) });
      }
      if (route === 'checkins' && method === 'POST') {
        action = 'recipe.checkin';
        const data = await body(request, 8192), value = checkins.validate(data);
        if (data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请重新打开打卡窗口。');
        operationId = value.id;
        const previous = await checkins.previous(user.id, value);
        if (previous) return reply({ userId: user.id, item: previous });
        const recipe = await database.latest(value.recipeId);
        if (!recipe || recipe.deleted) fail(404, 'NOT_FOUND', '这道菜谱已不存在，请同步菜谱。');
        target = recipe.recipe.title;
        const item = await checkins.add(user.id, value, target, receipt());
        return reply({ userId: user.id, item }, 201);
      }
      if (route === 'admin/audit-retention' && method === 'GET') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有管理员可以查看清理状态。');
        return reply({ userId: user.id, retention: await new AuditRetention(store).status() });
      }
      if (route.startsWith('admin/backup/') && method === 'POST') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有 wupanfeng 管理员可以生成完整迁移备份。');
        const data = await body(request, 16384);
        if (data?.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请重新登录后生成备份。');
        const backup = new FullBackup(store);
        if (route === 'admin/backup/start') {
          action = 'backup.full'; target = '完整迁移备份'; await record('success');
          return reply({ userId: user.id, snapshotAt: new Date().toISOString(), retentionDays: 7 });
        }
        snapshotTime(data.snapshotAt);
        if (route === 'admin/backup/catalog') return reply({ userId: user.id, ...await backup.catalog(data.cursor) });
        if (route === 'admin/backup/read') return reply({ userId: user.id, ...await backup.chunk(data.key, data.snapshotAt, data.offset) });
        if (route === 'admin/backup/verify') return reply({ userId: user.id, ...await backup.verify(data.items, data.snapshotAt) });
      }
      if (route === 'admin/photos' && method === 'GET') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有管理员可以管理图片空间。');
        const cursor = url.searchParams.get('cursor') || '';
        if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) fail(400, 'INVALID_CURSOR', '图片分页位置不正确。');
        return reply({ userId: user.id, ...await database.photos.inventory(cursor) });
      }
      if (route === 'admin/photos/cleanup' && method === 'POST') {
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有管理员可以清理图片。');
        const data = await body(request, 16384);
        if (data?.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请刷新后重试。');
        action = 'photo.cleanup'; target = '完全无引用图片'; operationId = data.mutationId;
        return reply({ userId: user.id, ...await database.photos.cleanup(user.id, data, receipt()) });
      }
      if (route.startsWith('admin/photos/') && method === 'PUT') {
        action = 'photo.optimize'; target = route.slice(13); operationId = target;
        if (user.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '只有管理员可以优化已有图片。');
        const { metadata, photos } = await photoBody();
        if (metadata?.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请刷新后重试。');
        if (photos.length !== 1) fail(400, 'INVALID_PHOTO_PACKET', '请每次处理一张图片。');
        const result = await database.photos.optimize(target, joinPhoto(photos[0]), receipt());
        await record('success'); return reply({ userId: user.id, result });
      }
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
        const [result, states, photoVersion] = await Promise.all([database.list(cursor), favorites.states(user.id), store.get('private/photo-cache-version.json', { type: 'json', consistency: 'strong' })]);
        if (!cursor) { action = 'recipes.sync'; await record('success'); }
        return reply({ userId: user.id, user, capabilities: { photoReferences: true, binaryPhotos: true, photoVersion: photoVersion?.version || '' }, items: result.items.map(event => publicEvent(event, favorites.value(event, user.id, states))), cursor: result.cursor });
      }
      if (route === 'trash' && method === 'GET') {
        if (!user.canEdit) fail(403, 'EDIT_PERMISSION_REQUIRED', '回收站需要编辑权限。');
        const cursor = url.searchParams.get('cursor') || '';
        if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) fail(400, 'INVALID_CURSOR', '分页位置不正确。');
        return reply({ userId: user.id, ...await database.trash(cursor) });
      }
      if (route.startsWith('photo/') && method === 'GET') {
        if (request.headers.get('accept') === PHOTO_PACKET_TYPE) {
          const photo = await database.photos.get(route.slice(6));
          if (!photo) fail(404, 'NOT_FOUND', '照片不存在。');
          return binaryReply(packPhotos({ userId: user.id }, [photo]), PHOTO_PACKET_TYPE);
        }
        const photo = await database.photo(route.slice(6));
        if (!photo) fail(404, 'NOT_FOUND', '照片不存在。');
        return reply({ photo });
      }
      if (route === 'photos' && method === 'POST') {
        const data = await body(request, 4096);
        if (!Array.isArray(data?.hashes) || !data.hashes.length || data.hashes.length > 8 || data.hashes.some(key => !/^[a-f0-9]{64}$/.test(key))) fail(400, 'INVALID_PHOTOS', '照片读取请求不正确。');
        const hashes = [...new Set(data.hashes)];
        if (request.headers.get('accept') === PHOTO_PACKET_TYPE) {
          const loaded = await Promise.all(hashes.map(key => database.photos.get(key)));
          if (loaded.some(photo => !photo)) fail(404, 'PHOTO_NOT_FOUND', '照片不存在，请重新同步菜谱。');
          const chosen = [], selected = [], pending = []; let size = 0;
          for (let i = 0; i < loaded.length; i++) {
            if (size && size + loaded[i].bytes.length > 3 * 1024 * 1024) pending.push(hashes[i]);
            else { size += loaded[i].bytes.length; chosen.push(loaded[i]); selected.push(hashes[i]); }
          }
          return binaryReply(packPhotos({ userId: user.id, hashes: selected, pending }, chosen), PHOTO_PACKET_TYPE);
        }
        const loaded = await Promise.all(hashes.map(key => database.photo(key)));
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
        const revision = url.searchParams.get('revision');
        const [states, history] = await Promise.all([favorites.states(user.id), revision ? database.version(id, revision).then(item => item ? [item] : []) : database.history(id)]);
        action = 'recipe.history'; target = history[0]?.recipe?.title || id; await record('success');
        return reply({ userId: user.id, items: history.map(event => publicEvent(event, favorites.value(event, user.id, states))) });
      }
      if (route.startsWith('trash/') && method === 'DELETE') {
        action = 'recipe.purge';
        if (!user.canEdit) fail(403, 'EDIT_PERMISSION_REQUIRED', '需要编辑权限才能彻底删除菜谱。');
        const id = decodeURIComponent(route.slice(6)); target = id;
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const data = await body(request, 4096); mutation(data); operationId = data.mutationId;
        if (data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请重新同步。');
        const result = await database.purge(id, data.baseRevision, receipt());
        if (result.auditEntry) operationId = result.auditEntry.operationId;
        if (result.complete) await record('success');
        return reply({ userId: user.id, complete: result.complete });
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
        let data;
        if (request.headers.get('content-type') === PHOTO_PACKET_TYPE && method === 'PUT') {
          const packet = await photoBody(); data = packet.metadata;
          if (packet.photos.length > 1 || !data?.recipe) fail(400, 'INVALID_PHOTO_PACKET', '菜谱照片数据不正确。');
          if (packet.photos[0]?.bytes.length > 160 * 1024) fail(413, 'PHOTO_TOO_LARGE', '照片需要压缩到 160 KB 以内。');
          data.recipe.photo = packet.photos.length ? joinPhoto(packet.photos[0]) : '';
        } else data = await body(request);
        mutation(data);
        if (data.expectedUserId && data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已切换，请重新同步。');
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
        if (recipe?.photo && request.headers.get('content-type') === PHOTO_PACKET_TYPE) {
          // A missing optimization hint is harmless and must not negate a saved recipe.
          await store.setJSON(`private/photo-optimized/${event.photoHash}.json`, { version: 1 }, { cacheControl: 'no-store' }).catch(() => {});
        }
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
