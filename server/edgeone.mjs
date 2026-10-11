import { getStore } from '@edgeone/pages-blob';
import { RecipeDatabase } from './database.mjs';
import { createApi } from './api.mjs';
import { publicEdgeOneRequest, DEFAULT_PUBLIC_ORIGIN } from './edgeone-request.mjs';

let handler;
export default async function onRequest({ request, env = {} }) {
  let publicRequest;
  try { publicRequest = publicEdgeOneRequest(request, process.env.PUBLIC_ORIGIN || env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN); }
  catch { return Response.json({ error: '部署域名配置不正确，请将 PUBLIC_ORIGIN 设置为完整的 HTTPS 网站入口。', code: 'PUBLIC_ORIGIN_INVALID' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
  if (!handler) {
    // Uses EdgeOne's injected server credential. No storage token is shipped to
    // the browser. Do not use the function's ephemeral filesystem as a database.
    try {
      const store = getStore({ name: process.env.FENGWEI_STORE_NAME || 'fengwei-recipes', consistency: 'strong' });
      handler = createApi({ database: new RecipeDatabase(store) });
    } catch {
      return Response.json({ error: '服务器持久化存储尚未连接，请检查 EdgeOne 的 Blob 服务是否可用。', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
    }
  }
  return handler(publicRequest);
}

export { onRequest };
