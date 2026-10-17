import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { hash } from './database.mjs';
import { isUserId, normalizeUsername, requireUniqueWrites } from './accounts.mjs';

const problem = (status, code, message) => Object.assign(new Error(message), { status, code });
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const derive = (text, salt) => new Promise((resolve, reject) => scrypt(text, salt, 32, (error, value) => error ? reject(error) : resolve(value)));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const lifetime = 10 * 60000;
const invalid = () => problem(400, 'EMAIL_CODE_INVALID', '验证码不正确、已失效或已使用，请重新获取。');
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw problem(400, 'INVALID_EMAIL', '请填写有效的邮箱地址。');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) || email.startsWith('.') || email.includes('..') || email.includes('.@')) throw problem(400, 'INVALID_EMAIL', '请填写有效的邮箱地址。');
  return email;
}

const deliveryMessages = {
  EMAIL_KEY_INVALID: '邮件服务密钥无效或已停用，请管理员检查当前邮件服务的 API 密钥后重新部署。',
  EMAIL_KEY_PERMISSION: '邮件服务密钥没有发送权限，请管理员检查密钥权限、发送者与域名范围。',
  EMAIL_IP_UNAUTHORIZED: 'Brevo 拦截了云函数的来源 IP，请管理员在 Security → Authorized IPs 核对本次发信请求并授权云函数出口 IP。',
  EMAIL_AUTH_FAILED: 'Brevo 拒绝了发信请求的认证，请管理员核对 API 密钥、邮件服务选择及 IP 授权记录。',
  EMAIL_DOMAIN_UNVERIFIED: '发信域名尚未通过验证，请管理员在 Resend 完成域名验证，并检查 FENGWEI_EMAIL_FROM 使用的是已验证域名。',
  EMAIL_DOMAIN_UNSUPPORTED: 'Resend 不接受这个免费公共域名，请改用独立域名，或联系管理员切换邮件服务。',
  EMAIL_TEST_RECIPIENT_RESTRICTED: '当前使用 Resend 测试发信地址，只能发给 Resend 账号自己的邮箱；向其他邮箱发送前，需要验证自己的发信域名。',
  EMAIL_FROM_INVALID: '发信地址格式不正确，请管理员检查 FENGWEI_EMAIL_FROM，填写已验证的发信邮箱，或使用“峰味 <发信邮箱>”格式。',
  EMAIL_SENDER_UNVERIFIED: '发信邮箱尚未验证或未启用，请管理员在 Brevo 的 Senders 中添加此邮箱并完成验证码验证。',
  EMAIL_ACCOUNT_PENDING: 'Brevo 账号或交易邮件服务尚未开通，请管理员完成账号审核并确认 Transactional 邮件已启用。',
  EMAIL_PROVIDER_QUOTA: '邮件服务发送额度已用完，请额度恢复后重试或联系管理员。',
  EMAIL_PROVIDER_DAILY_LIMIT: '邮件服务今日额度已用完，请额度恢复后重试或联系管理员。',
  EMAIL_PROVIDER_MONTHLY_LIMIT: '邮件服务本月额度已用完，请联系管理员。',
  EMAIL_SEND_BUSY: '邮件服务请求较多，请稍后重新获取验证码。',
  EMAIL_RETRY_CONFLICT: '发信配置可能已变化，请刷新页面后重新获取验证码。',
  EMAIL_NETWORK_UNAVAILABLE: '服务器连接邮件服务失败或超时，请稍后重试；持续失败请管理员检查云函数外网连接。',
  EMAIL_PROVIDER_UNAVAILABLE: '邮件服务暂时不可用，请稍后重试。',
  EMAIL_PROVIDER_RESPONSE_INVALID: '邮件服务返回了无效响应，请稍后重试或联系管理员。',
  EMAIL_SEND_UNAVAILABLE: '验证码邮件暂时发送失败，请稍后重试或联系管理员。',
};
function deliveryFailure(code, providerStatus = 0, provider = 'resend') {
  // Only static classifications are logged or returned. Provider bodies may
  // contain API keys, sender addresses or recipient addresses.
  console.error('Fengwei email delivery failed:', JSON.stringify({ provider, code, providerStatus }));
  return problem(503, code, deliveryMessages[code]);
}
function providerFailure(status, value, provider = 'resend') {
  const name = typeof value?.[provider === 'brevo' ? 'code' : 'name'] === 'string' ? value[provider === 'brevo' ? 'code' : 'name'] : '';
  const message = typeof value?.message === 'string' ? value.message.slice(0, 2000) : '';
  let code = 'EMAIL_SEND_UNAVAILABLE';
  if (provider === 'brevo' && [401, 403].includes(status) && /\bip(?:\s+address(?:es)?)?\b/i.test(message) && /unrecogni[sz]ed|unauthori[sz]ed|not authori[sz]ed|not verified|blocked|not allowed|whitelist|authori[sz]ation/i.test(message)) code = 'EMAIL_IP_UNAUTHORIZED';
  else if (provider === 'brevo' && name === 'account_under_validation') code = 'EMAIL_ACCOUNT_PENDING';
  else if (provider === 'brevo' && /sender.{0,180}(?:not valid|not verified|not activated|inactive|unverified)|(?:invalid|unverified).{0,100}sender/i.test(message)) code = 'EMAIL_SENDER_UNVERIFIED';
  else if (provider === 'brevo' && /(?:account|smtp|transactional).{0,160}(?:not (?:yet )?activated|not enabled|validation|suspend|not active)/i.test(message)) code = 'EMAIL_ACCOUNT_PENDING';
  else if (name === 'not_enough_credits') code = 'EMAIL_PROVIDER_QUOTA';
  else if (name === 'daily_quota_exceeded') code = 'EMAIL_PROVIDER_DAILY_LIMIT';
  else if (name === 'monthly_quota_exceeded') code = 'EMAIL_PROVIDER_MONTHLY_LIMIT';
  else if (['concurrent_idempotent_requests', 'rate_limit_exceeded', 'duplicate_request'].includes(name) || status === 429) code = 'EMAIL_SEND_BUSY';
  else if (name === 'invalid_idempotent_request') code = 'EMAIL_RETRY_CONFLICT';
  else if ((provider !== 'brevo' && status === 401) || ['missing_api_key', 'restricted_api_key', 'suspended_api_key'].includes(name) || /\b(?:api )?key\b.{0,80}(?:invalid|not found|not active|suspended)/i.test(message)) code = 'EMAIL_KEY_INVALID';
  else if (['invalid_permission', 'permission_denied'].includes(name)) code = 'EMAIL_KEY_PERMISSION';
  else if (provider === 'brevo' && (status === 401 || name === 'unauthorized')) code = 'EMAIL_AUTH_FAILED';
  else if (/only send (?:testing|test) emails/i.test(message)) code = 'EMAIL_TEST_RECIPIENT_RESTRICTED';
  else if (provider === 'resend' && /(?:not|don't) allow free public domains/i.test(message)) code = 'EMAIL_DOMAIN_UNSUPPORTED';
  else if (/domain.{0,200}(?:not verified|unverified)|(?:verify|verified).{0,150}domain/i.test(message)) code = 'EMAIL_DOMAIN_UNVERIFIED';
  else if (/from.{0,120}(?:invalid|not valid)|(?:invalid|valid).{0,120}from/i.test(message)) code = 'EMAIL_FROM_INVALID';
  else if (status >= 500) code = 'EMAIL_PROVIDER_UNAVAILABLE';
  return deliveryFailure(code, status, provider);
}

function emailSender(from, provider) {
  const match = /^(?:([^<>\r\n]+)<([^<>\r\n]+)>|([^<>\s]+))$/.exec(from);
  try {
    const email = normalizeEmail(match?.[2] || match?.[3]);
    const name = (match?.[1] || '峰味').trim().replace(/^"(.*)"$/, '$1');
    return { name, email };
  } catch { throw deliveryFailure('EMAIL_FROM_INVALID', 0, provider); }
}
function codeMessage(purpose, code) {
  const operation = { register: '注册账号', recover: '找回密码', bind: '绑定邮箱' }[purpose];
  return { subject: `峰味${operation}验证码`, text: `你正在峰味${operation}。\n\n验证码：${code}\n\n验证码 10 分钟内有效，请勿转发给他人。如非本人操作，请忽略这封邮件。` };
}
async function sendMailRequest(send, url, headers, body, provider) {
  let response;
  try { response = await send(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
  catch { throw deliveryFailure('EMAIL_NETWORK_UNAVAILABLE', 0, provider); }
  let value;
  try { value = await response.json(); }
  catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw deliveryFailure('EMAIL_NETWORK_UNAVAILABLE', response.status, provider);
    if (!response.ok) throw providerFailure(response.status, null, provider);
    throw deliveryFailure('EMAIL_PROVIDER_RESPONSE_INVALID', response.status, provider);
  }
  // Brevo reserves an idempotency key for longer than a code's 10-minute life.
  // Only its explicit idempotency acknowledgement confirms a lost first reply.
  if (provider === 'brevo' && response.status === 400 && value?.code === 'duplicate_parameter' && typeof value.message === 'string' && /idempotenc/i.test(value.message) && /already|duplicate|processed|used/i.test(value.message)) return { deduplicated: true };
  if (!response.ok) throw providerFailure(response.status, value, provider);
  const id = value?.[provider === 'brevo' ? 'messageId' : 'id'];
  if (typeof id !== 'string' || !id.trim()) throw deliveryFailure('EMAIL_PROVIDER_RESPONSE_INVALID', response.status, provider);
  return value;
}

export function createResendMailer({ apiKey = process.env.FENGWEI_RESEND_API_KEY, from = process.env.FENGWEI_EMAIL_FROM, fetch: send = globalThis.fetch } = {}) {
  apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  from = typeof from === 'string' ? from.trim() : '';
  const configured = !!apiKey && !!from;
  return {
    configured, provider: 'resend',
    async sendCode({ email, code, purpose, id }) {
      if (!configured) throw problem(503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，请联系管理员；已有账号仍可登录。');
      if (/[\s"']/.test(apiKey)) throw deliveryFailure('EMAIL_KEY_INVALID');
      emailSender(from, 'resend');
      await sendMailRequest(send, 'https://api.resend.com/emails', { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': `fengwei-email-${id}` }, { from, to: [email], ...codeMessage(purpose, code) }, 'resend');
    },
  };
}

export function createBrevoMailer({ apiKey = process.env.FENGWEI_BREVO_API_KEY, from = process.env.FENGWEI_EMAIL_FROM, fetch: send = globalThis.fetch } = {}) {
  apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  from = typeof from === 'string' ? from.trim() : '';
  return {
    configured: !!apiKey && !!from, provider: 'brevo',
    async sendCode({ email, code, purpose, id }) {
      if (!apiKey || !from) throw problem(503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，请联系管理员；已有账号仍可登录。');
      if (/[\s"']/.test(apiKey)) throw deliveryFailure('EMAIL_KEY_INVALID', 0, 'brevo');
      const sender = emailSender(from, 'brevo'), { subject, text } = codeMessage(purpose, code);
      const htmlContent = `<div style="white-space:pre-line;font-family:sans-serif;line-height:1.8">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</div>`;
      await sendMailRequest(send, 'https://api.brevo.com/v3/smtp/email', { 'api-key': apiKey }, { sender, to: [{ email }], subject, textContent: text, htmlContent, headers: { idempotencyKey: id } }, 'brevo');
    },
  };
}

export function createEmailMailer({ provider = process.env.FENGWEI_EMAIL_PROVIDER, resendApiKey = process.env.FENGWEI_RESEND_API_KEY, brevoApiKey = process.env.FENGWEI_BREVO_API_KEY, from = process.env.FENGWEI_EMAIL_FROM, fetch: send = globalThis.fetch } = {}) {
  const selected = typeof provider === 'string' && provider.trim() ? provider.trim().toLowerCase() : brevoApiKey?.trim() ? 'brevo' : 'resend';
  if (selected === 'resend') return createResendMailer({ apiKey: resendApiKey, from, fetch: send });
  if (selected === 'brevo') return createBrevoMailer({ apiKey: brevoApiKey, from, fetch: send });
  const configurationError = problem(503, 'EMAIL_PROVIDER_INVALID', '邮件服务类型不正确，请将 FENGWEI_EMAIL_PROVIDER 设置为 brevo 或 resend 后重新部署。');
  return { configured: false, configurationError, async sendCode() { throw configurationError; } };
}

export class EmailAuth {
  constructor(accounts, limits, mailer) { this.accounts = accounts; this.store = accounts.store; this.limits = limits; this.mailer = mailer; }
  key(id) { if (!uuid(id)) throw invalid(); return `private/email-challenges/${id}.json`; }
  head(record) { return `private/email-code-heads/${record.purpose}/${hash(JSON.stringify([record.email, record.userId]))}/`; }
  async secret() {
    const value = await this.accounts.reserve('private/email-secrets/v1.json', { key: randomBytes(32).toString('hex') });
    if (!/^[a-f0-9]{64}$/.test(value?.key || '')) throw new Error('Email secret unavailable');
    return value.key;
  }
  code(record, secret) { return String(parseInt(createHmac('sha256', secret).update(`code:${record.id}`).digest('hex').slice(0, 12), 16) % 1000000).padStart(6, '0'); }
  proof(record, code, secret) { return createHmac('sha256', secret).update(JSON.stringify(['verify', record.id, record.email, record.purpose, record.userId, code])).digest('hex'); }
  async account(identifier) {
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 64) throw problem(400, 'INVALID_ACCOUNT', '请填写用户名或账号 ID。');
    const name = normalizeUsername(identifier);
    if (name === normalizeUsername(this.accounts.legacy?.username || '') || name === this.accounts.legacyId) return this.accounts.original(false);
    if (isUserId(name)) return this.accounts.get(name);
    const matches = await this.accounts.named(name);
    return matches.length === 1 ? matches[0] : null;
  }
  async request(data, address, session) {
    if (!this.mailer?.configured) throw this.mailer?.configurationError || problem(503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，请联系管理员；已有账号仍可登录。');
    if (!uuid(data?.requestId) || !['register', 'recover', 'bind'].includes(data?.purpose)) throw problem(400, 'INVALID_EMAIL_REQUEST', '邮箱验证请求不完整，请重新打开页面。');
    const email = normalizeEmail(data.email), { purpose } = data;
    if (purpose === 'bind' && (!session || data.expectedUserId !== session.user.id)) throw problem(401, 'LOGIN_REQUIRED', '请重新登录后绑定邮箱。');
    // Limits are shared across cloud instances. Recovery responses never reveal
    // whether a username or its verified email matches.
    await this.limits.consume('email-source', address, 5, 900000, 'EMAIL_TRY_LATER', '验证码请求较多，请 15 分钟后再试。');
    let user = purpose === 'recover' ? await this.account(data.username) : purpose === 'bind' ? await this.accounts.authenticate(session.user.id, data.currentPassword) : null;
    if (purpose === 'bind' && (!user || user.passwordVersion !== session.account.passwordVersion)) throw problem(400, 'CURRENT_PASSWORD_INCORRECT', '当前密码不正确或登录已变化，请重新登录后操作。');
    if (purpose === 'bind' && user.email && user.email !== email) throw problem(409, 'EMAIL_ALREADY_BOUND', '账号已绑定邮箱，暂不支持在此更换。');
    const userId = purpose === 'register' ? null : user?.id || null;
    const existing = await this.store.get(this.key(data.requestId), { type: 'json', consistency: 'strong' });
    if (existing && (existing.email !== email || existing.purpose !== purpose || existing.userId !== userId || existing.expiresAt <= Date.now())) throw invalid();
    if (!existing) {
      await this.limits.consume('email-cooldown', email, 1, 60000, 'EMAIL_COOLDOWN', '请间隔 60 秒后再获取验证码。');
      await this.limits.consume('email-address', email, 5, 3600000, 'EMAIL_TRY_LATER', '该邮箱验证码请求较多，请稍后再试。');
    }
    const response = { ok: true, challengeId: data.requestId, expiresIn: 600, retryAfter: 60, message: purpose === 'recover' ? '如账号与绑定邮箱匹配，验证码将发送至该邮箱，请检查收件箱和垃圾邮件。' : '验证码已发送，请检查收件箱和垃圾邮件，10 分钟内有效。' };
    if (purpose === 'recover' && (!user || !user.emailVerifiedAt || user.email !== email)) return response;
    if (!existing) {
      const now = new Date();
      await this.limits.consume('email-daily', now.toISOString().slice(0, 10), 90, 86400000, 'EMAIL_DAILY_LIMIT', '今日邮件发送额度已用完，请明天再试或联系管理员。');
      await this.limits.consume('email-monthly', now.toISOString().slice(0, 7), 2900, 32 * 86400000, 'EMAIL_MONTHLY_LIMIT', '本月邮件发送额度已用完，请联系管理员。');
    }
    await requireUniqueWrites(this.store);
    const secret = await this.secret();
    const candidate = { id: data.requestId, purpose, email, userId, credentialVersion: user?.passwordVersion || null, createdAt: Date.now(), expiresAt: Date.now() + lifetime };
    candidate.codeHash = this.proof(candidate, this.code(candidate, secret), secret);
    const record = await this.accounts.reserve(this.key(candidate.id), candidate);
    if (record.email !== email || record.purpose !== purpose || record.userId !== userId || record.expiresAt <= Date.now()) throw invalid();
    const marker = `private/email-code-sent/${record.id}.json`;
    if (!await this.store.get(marker, { type: 'json', consistency: 'strong' })) {
      await this.mailer.sendCode({ email, purpose, id: record.id, code: this.code(record, secret) });
      await this.accounts.reserve(marker, { accepted: true });
    }
    await this.accounts.reserve(`${this.head(record)}${String(record.createdAt).padStart(13, '0')}-${record.id}.json`, { id: record.id });
    return response;
  }
  async verify(data, purpose, intent, expectedUserId) {
    const email = normalizeEmail(data?.email);
    if (!uuid(data?.challengeId) || typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) throw invalid();
    const record = await this.store.get(this.key(data.challengeId), { type: 'json', consistency: 'strong' });
    if (!record || record.purpose !== purpose || record.email !== email || record.expiresAt <= Date.now()) throw invalid();
    if (expectedUserId !== undefined && record.userId !== expectedUserId) throw invalid();
    await this.limits.consume('email-verify', record.id, 5, lifetime, 'EMAIL_CODE_LOCKED', '验证码尝试次数已用完，请重新获取。');
    const { blobs } = await this.store.list({ prefix: this.head(record), consistency: 'strong' });
    const latest = blobs.map(item => item.key).sort().at(-1);
    const head = latest && await this.store.get(latest, { type: 'json', consistency: 'strong' });
    if (head?.id !== record.id || !await this.store.get(`private/email-code-sent/${record.id}.json`, { type: 'json', consistency: 'strong' }) || !equal(record.codeHash, this.proof(record, data.code, await this.secret()))) throw invalid();
    const key = `private/email-code-uses/${record.id}.json`;
    const salt = randomBytes(16).toString('hex');
    const used = await this.accounts.reserve(key, { salt, requestHash: (await derive(JSON.stringify(intent), salt)).toString('hex') });
    if (!/^[a-f0-9]{32}$/.test(used?.salt || '') || !equal(used.requestHash, (await derive(JSON.stringify(intent), used.salt)).toString('hex'))) throw invalid();
    return record;
  }
}
