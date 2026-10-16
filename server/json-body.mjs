export class JsonBodyError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}
const fail = (status, code, message) => { throw new JsonBodyError(status, code, message); };
const tooLarge = () => fail(413, 'TOO_LARGE', '这道菜或照片太大，请缩小照片后再保存。');

export async function readBodyBytes(request, limit = 4 * 1024 * 1024) {
  if (Number(request.headers.get('content-length')) > limit) tooLarge();
  let bytes;
  try {
    // EdgeOne's enhanced Request has its own parsed `body` getter, which can
    // return a promise and can reject during preload. Do not touch that getter
    // or serialize its object. Its standard arrayBuffer/text readers still
    // consume the original bytes. Native Requests retain the bounded stream
    // path so oversized chunked requests are cancelled before buffering all.
    const stream = Object.hasOwn(request, 'body') ? null : request.body;
    if (typeof stream?.getReader === 'function') {
      const reader = stream.getReader();
      let size = 0;
      const parts = [];
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) { await reader.cancel(); tooLarge(); }
          parts.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      bytes = Buffer.concat(parts, size);
    } else if (typeof request.arrayBuffer === 'function') {
      bytes = Buffer.from(await request.arrayBuffer());
    } else if (typeof request.text === 'function') {
      bytes = Buffer.from(await request.text(), 'utf8');
    } else {
      fail(400, 'BODY_UNREADABLE', '服务器未能读取请求内容，请刷新后重试。');
    }
  } catch (error) {
    if (error instanceof JsonBodyError) throw error;
    // No request contents, passwords, cookies or headers in diagnostics.
    fail(400, 'BODY_UNREADABLE', '服务器未能读取请求内容，请刷新后重试。');
  }
  if (bytes.length > limit) tooLarge();
  if (!bytes.length) fail(400, 'EMPTY_BODY', '服务器没有收到请求内容，请刷新后重试。');
  return bytes;
}
export async function readJsonBody(request, limit = 4 * 1024 * 1024) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) fail(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式。');
  const bytes = await readBodyBytes(request, limit);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'INVALID_JSON', '请求内容不是有效的 JSON。'); }
}
