import { hash } from './database.mjs';
import { validateRecipe } from '../dist/store.js';
import { createAuth, testAccount, sessionCookie } from './auth.mjs';
import { readJsonBody as body } from './json-body.mjs';
import { publicUser } from './accounts.mjs';
import { Favorites } from './favorites.mjs';

const failures = new Map();
const registrations = new Map();
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
export function createApi({ database, password }) {
  const auth = password === undefined ? createAuth(database?.store) : createAuth(database?.store, testAccount(password));
  const favorites = new Favorites(database.store, auth.accounts.legacyId);
  return async request => {
    let renewedCookie;
    const reply = (value, status = 200, headers = {}) => json(value, status, { ...(renewedCookie ? { 'Set-Cookie': renewedCookie } : {}), ...headers });
    try {
      if (!auth.configured) fail(503, 'NOT_CONFIGURED', '服务器账号尚未完成配置，请重新部署完整的峰味上传包。');
      const url = new URL(request.url), route = url.pathname.replace(/^.*?\/api\//, ''), method = request.method;
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) fail(400, 'HTTPS_REQUIRED', '请通过 HTTPS 正式网址使用私人菜谱本。');
      if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式。');
      if (method !== 'GET') writableOrigin(request);
      if (route === 'login' && method === 'POST') {
        const data = await body(request, 4096);
        const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
        const key = hash(address), attempt = failures.get(key);
        if (attempt && attempt.expires > Date.now() && attempt.count >= 10) fail(429, 'TRY_LATER', '尝试次数较多，请 5 分钟后再试。');
        const user = await auth.accounts.authenticate(data?.username, data?.password);
        if (!user) {
          if (failures.size > 2000) for (const [key, item] of failures) if (item.expires < Date.now()) failures.delete(key);
          failures.set(key, { count: attempt?.expires > Date.now() ? attempt.count + 1 : 1, expires: Date.now() + 300000 });
          fail(401, 'BAD_CREDENTIALS', '账号或密码不正确。');
        }
        failures.delete(key);
        // Verify durable storage before claiming that login/server setup works.
        await database.headKeys();
        return reply({ ok: true, user: publicUser(user) }, 200, { 'Set-Cookie': sessionCookie(request, await auth.issue(user)) });
      }
      if (route === 'register' && method === 'POST') {
        const data = await body(request, 4096);
        const address = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
        const key = hash(address), previous = registrations.get(key);
        const attempt = previous?.expires > Date.now() ? previous : { count: 0, expires: Date.now() + 3600000 };
        if (attempt.count >= 20) fail(429, 'REGISTER_LATER', '注册次数较多，请稍后再试。');
        attempt.count++; registrations.set(key, attempt);
        if (registrations.size > 2000) for (const [key, item] of registrations) if (item.expires < Date.now()) registrations.delete(key);
        const user = await auth.accounts.register(data);
        return reply({ ok: true, user: publicUser(user) }, 201, { 'Set-Cookie': sessionCookie(request, await auth.issue(user)) });
      }
      if (route === 'logout' && method === 'POST') return reply({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
      const session = await auth.verify(request);
      if (!session) fail(401, 'LOGIN_REQUIRED', '请先输入账号和密码，打开你的私人菜谱本。');
      if (session.renew) renewedCookie = sessionCookie(request, await auth.issue(session.user));
      const user = session.user;
      if (route === 'me' && method === 'GET') return reply({ user });
      if (route === 'recipes' && method === 'GET') {
        const cursor = url.searchParams.get('cursor') || '';
        if (cursor && !/^[a-f0-9]{64}$/.test(cursor)) fail(400, 'INVALID_CURSOR', '分页位置不正确。');
        const result = await database.list(cursor);
        const states = await favorites.states(user.id);
        return reply({ userId: user.id, items: result.items.map(event => publicEvent(event, favorites.value(event, user.id, states))), cursor: result.cursor });
      }
      if (route.startsWith('photo/') && method === 'GET') {
        const photo = await database.photo(route.slice(6));
        if (!photo) fail(404, 'NOT_FOUND', '照片不存在。');
        return reply({ photo });
      }
      if (route.startsWith('history/') && method === 'GET') {
        const id = decodeURIComponent(route.slice(8));
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const states = await favorites.states(user.id);
        return reply({ userId: user.id, items: (await database.history(id)).map(event => publicEvent(event, favorites.value(event, user.id, states))) });
      }
      if (route.startsWith('favorite/') && method === 'PUT') {
        const id = decodeURIComponent(route.slice(9));
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const data = await body(request, 4096);
        if (typeof data?.favorite !== 'boolean' || !/^[a-zA-Z0-9-]{8,128}$/.test(data?.mutationId || '')) fail(400, 'INVALID_FAVORITE', '收藏请求不完整，请重试。');
        if (data.expectedUserId && data.expectedUserId !== user.id) fail(409, 'ACCOUNT_CHANGED', '账号已在其他页面切换，请重新同步后操作。');
        const current = await database.latest(id);
        if (!current || current.deleted) fail(404, 'NOT_FOUND', '这道菜谱已不存在，请同步菜谱。');
        await favorites.preserveLegacy(current);
        await favorites.set(user.id, id, data.favorite, data.mutationId);
        return reply({ userId: user.id, id, favorite: data.favorite });
      }
      if (route.startsWith('recipe/') && ['PUT', 'DELETE'].includes(method)) {
        const id = decodeURIComponent(route.slice(7));
        if (!id || id.length > 128 || id.includes('/')) fail(400, 'INVALID_ID', '菜谱编号不正确。');
        const data = await body(request); mutation(data);
        let recipe = null;
        if (method === 'PUT') {
          try { recipe = validateRecipe(data.recipe); } catch (error) { fail(400, 'INVALID_RECIPE', error.message); }
          if (recipe.id !== id) fail(400, 'INVALID_ID', '菜谱编号不一致。');
          if (recipe.photo.length > 3 * 1024 * 1024 || Buffer.byteLength(JSON.stringify({ ...recipe, photo: '' }), 'utf8') > 150000) fail(413, 'TOO_LARGE', '菜谱文字或照片太大，请缩小内容后保存。');
          // Favorites are private account state, never part of a shared save.
          recipe.favorite = false;
        }
        await favorites.preserveLegacy(await database.latest(id));
        const event = await database.commit({ id, recipe, baseRevision: data.baseRevision, mutationId: data.mutationId });
        const states = await favorites.states(user.id);
        return reply({ userId: user.id, item: publicEvent(event, favorites.value(event, user.id, states)) });
      }
      fail(404, 'NOT_FOUND', '接口不存在，请确认已部署完整的峰味服务端。');
    } catch (error) {
      if (error.status) return reply({ error: error.message, code: error.code || 'REQUEST_FAILED' }, error.status);
      console.error('Fengwei storage error:', error.code || error.name);
      return json({ error: '服务器存储暂时不可用，数据尚未确认保存，请稍后重试。', code: 'STORAGE_UNAVAILABLE' }, 503);
    }
  };
}
