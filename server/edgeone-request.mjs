export const DEFAULT_PUBLIC_ORIGIN = 'https://www.wupanfeng.dpdns.org';

// TLS ends at EdgeOne. Its Node function adapter can expose an internal HTTP
// URL/host even when the browser used HTTPS. Use the configured deployment
// origin here, not arbitrary Origin/Forwarded headers supplied by a client.
// Local/self-hosted callers continue to use the strict unmodified request.
export function publicEdgeOneRequest(request, origin = DEFAULT_PUBLIC_ORIGIN) {
  const publicUrl = new URL(origin);
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('Invalid public HTTPS origin');
  const internal = new URL(request.url);
  const target = new URL(publicUrl.origin);
  target.pathname = internal.pathname;
  target.search = internal.search;
  // EdgeOne shadows Request.body with parsed JSON (or a promise for it).
  // Reconstructing a Request would turn that value into "[object Object]" or
  // "[object Promise]". Only override URL metadata; keep the original body
  // readers and their receiver, including native Request internal slots.
  return new Proxy(request, {
    get(original, key) {
      if (key === 'url') return target.href;
      const value = Reflect.get(original, key, original);
      return typeof value === 'function' ? value.bind(original) : value;
    },
  });
}
