import { getStore } from '@edgeone/pages-blob';
import { RecipeDatabase } from './database.mjs';
import { createApi } from './api.mjs';
import { publicEdgeOneRequest, DEFAULT_PUBLIC_ORIGIN } from './edgeone-request.mjs';
import { createAccountStore } from './account-store.mjs';
import { createEmailMailer } from './email-auth.mjs';

let handler;
export default async function onRequest({ request, env = {}, clientIp }) {
  let publicRequest;
  try { publicRequest = publicEdgeOneRequest(request, process.env.PUBLIC_ORIGIN || env.PUBLIC_ORIGIN || DEFAULT_PUBLIC_ORIGIN); }
  catch { return Response.json({ error: '部署域名配置不正确，请将 PUBLIC_ORIGIN 设置为完整的 HTTPS 网站入口。', code: 'PUBLIC_ORIGIN_INVALID' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
  if (!handler) {
    // Uses EdgeOne's injected server credential. No storage token is shipped to
    // the browser. Do not use the function's ephemeral filesystem as a database.
    try {
      const blobNamespace = process.env.FENGWEI_STORE_NAME || env.FENGWEI_STORE_NAME || 'fengwei-recipes';
      const store = createAccountStore(getStore({ name: blobNamespace, consistency: 'strong' }), {
        url: process.env.FENGWEI_SUPABASE_URL || env.FENGWEI_SUPABASE_URL,
        secretKey: process.env.FENGWEI_SUPABASE_SECRET_KEY || env.FENGWEI_SUPABASE_SECRET_KEY,
        namespace: process.env.FENGWEI_ACCOUNT_NAMESPACE || env.FENGWEI_ACCOUNT_NAMESPACE || blobNamespace,
      });
      handler = createApi({ database: new RecipeDatabase(store), mailer: createEmailMailer({ provider: process.env.FENGWEI_EMAIL_PROVIDER || env.FENGWEI_EMAIL_PROVIDER, resendApiKey: process.env.FENGWEI_RESEND_API_KEY || env.FENGWEI_RESEND_API_KEY, brevoApiKey: process.env.FENGWEI_BREVO_API_KEY || env.FENGWEI_BREVO_API_KEY, from: process.env.FENGWEI_EMAIL_FROM || env.FENGWEI_EMAIL_FROM }) });
    } catch {
      return Response.json({ error: '服务器持久化存储尚未连接，请检查 EdgeOne 的 Blob 服务是否可用。', code: 'STORAGE_UNAVAILABLE' }, { status: 503, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
    }
  }
  return handler(publicRequest, { clientIp: typeof clientIp === 'string' && clientIp ? clientIp : 'unknown' });
}

export { onRequest };
