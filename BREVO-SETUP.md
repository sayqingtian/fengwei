# 不购买独立域名：Brevo 邮箱验证码配置

此方案使用 Brevo HTTP API 发送峰味的注册、绑定邮箱和密码找回验证码。网站继续使用原 EdgeOne 地址，账号和菜谱沿用已有数据库。

Brevo 当前免费计划含每天 300 封邮件和交易邮件功能。[官方额度](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)

Brevo 支持通过发送到邮箱的六位验证码验证发信人。使用免费邮箱地址时，它会按当前政策将发信域名替换为 `brevosend.com` 代发，因此收件人可能看到这个域名。该行为由服务商控制，实际可用性和送达以账号审核、交易邮件启用及试发结果为准；不能承诺永远无需域名或所有收件箱均可送达。[验证发信人](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email)、[免费邮箱代发说明](https://help.brevo.com/hc/en-us/articles/16045394674066-Troubleshooting-Domain-authentication)

## 1. 注册并验证发信邮箱

1. 在 [Brevo](https://www.brevo.com/) 注册 Free 免费账号，完成注册邮箱验证、真实账号资料以及平台要求的审核。
2. 网站地址可填写已有峰味地址 `https://www.wupanfeng.dpdns.org`。用途如实填写“共享菜谱应用的注册与密码找回验证码，由用户主动触发，发送量较小”。
3. 打开 **Settings → Senders, Domains, IPs → Senders → Add a sender**。
4. From name 填 `峰味`，From email 填你实际拥有、能收信的邮箱。这里创建的是 Sender（发信人），无需把 `gmail.com` 等公共邮箱域名添加到 Domains。
5. 在该邮箱中查收 Brevo 的六位验证码，回到 Brevo 完成 **Verify sender**。确认发信人已验证、Transactional 交易邮件功能已启用。

没有独立域名时，请使用平台允许验证的现有邮箱；不要虚构 `noreply@wupanfeng.dpdns.org` 或 `noreply@brevosend.com`。后者由 Brevo 自动处理，不能自行冒用。如果具体邮箱无法验证，以平台给出的提示为准。

## 2. 创建 API v3 密钥

打开 **SMTP & API → API Keys**，创建用于峰味发信的 API v3 密钥并保存完整值。这里需要 **API Key**，不是 SMTP Key，也不是邮箱登录密码。按 Brevo 提示配置账号安全要求和 API 访问权限。

## 3. 填写 EdgeOne 生产环境变量

在当前项目环境变量中设置：

| 变量名 | 值 |
| --- | --- |
| `FENGWEI_EMAIL_PROVIDER` | `brevo` |
| `FENGWEI_BREVO_API_KEY` | 上一步创建的完整 API v3 密钥 |
| `FENGWEI_EMAIL_FROM` | `峰味 <你刚验证的发信邮箱>`，例如 `峰味 <yourname@gmail.com>` |

变量作用范围包含 **Production 生产环境**，保存后重新部署。将例子中的邮箱替换为自己的真实已验证地址，在 EdgeOne 中不要给整个值额外加引号。密钥只填 EdgeOne，不发送到聊天、不提交 GitHub、不放在前端。

显式设置 `brevo` 后，原 `FENGWEI_RESEND_API_KEY` 不参与发送，也不会在 Brevo 失败时切到 Resend 重发。原 Supabase、Blob、域名和账号配置沿用，不需要执行新的 SQL。更改环境变量后必须重新部署才能让新的云函数配置生效。

## 4. 检查真实送达

1. 重新部署完成后刷新网站；主屏幕应用可使用“检查更新”。
2. 登录已有管理员账号，打开“我的 → 我的账号 → 绑定找回邮箱”，填写当前密码和邮箱，点击获取验证码。
3. 同时检查收件箱、垃圾邮件文件夹和 Brevo 的 **Transactional → Logs**。API 受理仅表示进入邮件服务，不等于已送达；应确认有真实邮件后再完成绑定。
4. 用自己创建的测试账号验证邮箱注册、忘记密码、错误验证码、新密码登录和旧密码失效。

峰味仍保留 10 分钟有效期、60 秒重发间隔、每码 5 次验证、来源限制和跨云函数的原子消费。全站继续采用保守的每天 90 次、每月 2,900 次发送请求上限；这是应用防刷额度，低于 Brevo 免费日额度，切换服务商也不会清空计数。失败或并发请求可能占用预留次数。

## 常见提示

- **发信邮箱尚未验证或未启用**：检查 Brevo Senders 的真实发信邮箱是否已完成验证，并与 `FENGWEI_EMAIL_FROM` 完全对应。
- **Brevo 账号或交易邮件服务尚未开通**：按控制台要求完成审核或联系 Brevo 支持，等待 Transactional 功能可用。
- **密钥无效或已停用**：确认复制的是完整 API v3 Key，而非 SMTP Key；检查是否已停用，更新 EdgeOne 后重新部署。
- **没有发送权限**：检查 Brevo API 权限、账号安全策略、账号状态及发信人。云函数出口 IP 由平台决定，应按 Brevo 的实际安全提示处理。
- **Brevo 拦截了云函数的来源 IP**：打开 Security → Authorized IPs → Unauthorized IP addresses，核对试发时间及对应请求后，授权实际发起调用的云函数出口 IP。浏览器或电脑访问网站所用的地址不能代表云函数出口。手动添加授权 IP 会开启对未授权 IP 的限制；操作前应确认所需的调用来源。参考 [官方 IP 授权说明](https://help.brevo.com/hc/en-us/articles/5740111683858-Authorize-and-block-IP-addresses-for-API-and-SMTP-security)。
- **Brevo 拒绝了发信请求的认证**：提供方只返回了笼统的认证失败，不能仅据此判断密钥已失效。核对 `FENGWEI_EMAIL_PROVIDER=brevo`、完整 API v3 密钥、生产部署是否包含新变量，以及 Brevo 的 IP 授权记录。
- **邮件服务额度已用完**：查看 Brevo 的实际剩余额度。免费额度可能与该账号的其他邮件任务共用，排队中的验证码可能在送达前过期。
- **连接失败或超时**：检查 EdgeOne 到 `https://api.brevo.com` 的连通性。云函数日志只记录提供方、安全错误分类和 HTTP 状态，不包含邮箱、验证码、API 密钥或原始提供方正文。

服务端已完成协议模拟、注册与重置流程测试；真实邮件送达需要以上述账号与环境配置实际验证。
