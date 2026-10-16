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

export function createResendMailer({ apiKey = process.env.FENGWEI_RESEND_API_KEY, from = process.env.FENGWEI_EMAIL_FROM, fetch: send = globalThis.fetch } = {}) {
  const configured = typeof apiKey === 'string' && !!apiKey.trim() && typeof from === 'string' && !!from.trim() && !/[\r\n]/.test(from);
  return {
    configured,
    async sendCode({ email, code, purpose, id }) {
      if (!configured) throw problem(503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，请联系管理员；已有账号仍可登录。');
      const operation = { register: '注册账号', recover: '找回密码', bind: '绑定邮箱' }[purpose];
      let response;
      try {
        response = await send('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `fengwei-email-${id}` },
          body: JSON.stringify({ from, to: [email], subject: `峰味${operation}验证码`, text: `你正在峰味${operation}。\n\n验证码：${code}\n\n验证码 10 分钟内有效，请勿转发给他人。如非本人操作，请忽略这封邮件。` }),
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok || typeof (await response.json()).id !== 'string') throw new Error('Mail not accepted');
      } catch { throw problem(503, 'EMAIL_SEND_UNAVAILABLE', '验证码邮件暂时发送失败，请稍后重试或联系管理员。'); }
    },
  };
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
    if (!this.mailer?.configured) throw problem(503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，请联系管理员；已有账号仍可登录。');
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
