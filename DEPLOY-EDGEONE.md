# 峰味：多账号版部署

本版支持注册、账号 ID 登录、Cookie 免登录、共享菜谱与独立收藏。账号及密码使用 Supabase PostgreSQL；菜谱、照片、收藏、权限、会话签名和日志继续使用现有 EdgeOne Blob。

## 账号数据库初始化

1. 打开 [Supabase Dashboard](https://supabase.com/dashboard)，登录后创建项目。可先使用 Free 方案。项目数据库密码由你自行设置，与峰味账号密码无关。
2. 在项目的 SQL Editor 中，新建查询，粘贴本仓库 [scripts/setup-supabase.sql](scripts/setup-supabase.sql) 的完整内容并执行。脚本创建 `fengwei_account_records`，主键保证相同账号记录只能占用一次；启用 RLS 并关闭浏览器角色访问。脚本可重复执行，不删除已有记录。
3. 从项目 Connect 面板或 Settings 获取 Project URL，并从 API Keys 获取一个以 `sb_secret_` 开头的服务端 Secret Key。不要使用 `sb_publishable_` 或 anon key。旧的 service_role JWT 也兼容，但新项目建议使用 Secret Key。
4. 在 EdgeOne 项目的生产环境变量中设置下表的两个必填值。只在控制台填写密钥，不提交 Git，不放到前端代码，也无需发到聊天里。保存后重新部署，使环境变量生效。

| 环境变量 | 值 |
| --- | --- |
| `FENGWEI_SUPABASE_URL` | Supabase Project URL，例如 `https://your-project.supabase.co` |
| `FENGWEI_SUPABASE_SECRET_KEY` | Supabase 服务端 Secret Key，通常以 `sb_secret_` 开头 |
| `FENGWEI_ACCOUNT_NAMESPACE`（可选） | 默认沿用 Blob 命名空间 `fengwei-recipes`；已有数据时保持不变 |

5. 访问网站的 `/api/health`。HTTP 200 且返回 `{"ok":true,"registration":true}` 表示数据库连接、条件插入和读取均正常。再注册账号并验证登录。HTTP 503 的 `ACCOUNT_DATABASE_NOT_CONFIGURED` 表示缺少环境变量；`ACCOUNT_DATABASE_AUTH_FAILED` 表示密钥或数据库权限不正确；`ACCOUNT_DATABASE_SCHEMA_REQUIRED` 表示尚未建表或项目 URL 不正确；`ACCOUNT_DATABASE_CONNECTION_FAILED` 表示数据库无法连接。

原 Blob 中的用户资料、用户名占用、注册重试记录、密码版本及密码头索引会在读取时迁入 SQL，已有账号 ID、当前密码、管理员身份和收藏归属保持不变。迁移采用只插入、不覆盖已有 SQL 记录的方式；先保留原 Blob 作为迁移来源。首次正常连接后会记录数据库绑定，之后不能通过移除数据库配置回退到旧密码。更换 Supabase 项目或 namespace 需要先迁移账号数据，不要把改环境变量作为数据迁移方式。

本地开发继续使用 `.data/fengwei`，不需要配置 Supabase。SQL 数据库与 Blob 均需独立备份，菜谱 JSON 备份不包含账号、密码、权限或日志。Supabase Free 项目长期低活跃可能暂停，需在控制台恢复；详情见 [项目暂停说明](https://supabase.com/docs/guides/platform/free-project-pausing)。

## 性能优化部署

性能优化版沿用原账号表与 Blob，不需要新的环境变量或 SQL。首次访问账号会检查并完整迁入其旧 Blob 密码链，同时在账号表保存迁移标记；之后每次验证从新的 SQL 快照读取密码状态，密码变更仍立即使旧登录失效。

保存、收藏、申请提交和管理员处理使用接口已经确认的结果更新页面，照片改为分组并行读取。仅修改菜谱文字时，已有照片不再重复上传。同步包含账号资料，菜谱每页最多 100 条并受响应大小约束；通过“同步菜谱”读取其他设备的变更。部署后更新离线应用缓存，刷新网页使用新版。

API 返回 `Server-Timing: app;dur=...`，数值表示应用内处理的毫秒数，不包含所有平台启动和网络传输时间。数据库地区尚未核实时，保持现有函数地区；若跨地区延迟仍高，可按照 [官方说明](https://pages.edgeone.ai/document/cloud-functions) 将函数部署在靠近数据库的地区，同时核对 Blob 访问耗时。

## 管理员处理密码找回

数据库初始化完成后，找回功能直接沿用 `fengwei_account_records`，无需新增环境变量或再次执行 SQL。登录页不预填账号和密码。“忘记密码？”提交账号、线下联系方式和备注后，管理员在“我的 → 密码找回”收到申请，并可查看待处理数量。

管理员需先通过已有的线下联系渠道核实身份，设置新密码或生成随机密码，确认重置后复制结果窗口内的新密码并线下告知用户。关闭窗口后不会再次显示新密码；用户登录后可在“我的账号 → 修改密码”中修改。拒绝申请不会改变原密码；重置成功后原密码和旧登录失效，账号、收藏及权限保留。密码变更使尚未处理的旧申请失效，申请 7 天后过期。

申请及重置命令保存在 Supabase 服务端账号表中；重置命令只包含盐与密码哈希。用户提交申请不会自动重置密码或获得登录。管理员的处理和找回申请会记录到操作日志，不包含联系方式和明文密码。账号数据库备份也应包含这些找回记录。

## GitHub 关联部署

在 EdgeOne 导入此仓库后，根目录保留 `./`，框架预设选择 Other。根目录的 `edgeone.json` 会覆盖安装、构建及输出目录设置；也可以在“项目设置 → 构建部署配置”中填写：

| 设置 | 值 |
| --- | --- |
| 根目录 | `./` |
| 框架预设 | Other |
| 安装命令 | `npm ci` |
| 构建命令 | `npm run build` |
| 输出目录 | `artifacts/fengwei-edgeone` |
| Node.js | `22.11.0` |

`npm run build` 会在输出目录生成根部首页、静态文件、编译后的云函数与存储 SDK。仓库根部的 `cloud-functions/api/[[default]].js` 供 Git 部署识别云函数；它与 ZIP 构建使用同一个服务端入口。生成的 ZIP 包仅供直接上传，无需提交到 Git。

部署后先从控制台复制默认访问地址进行检查。若使用默认域名或其他自定义域名，在该部署环境将 `PUBLIC_ORIGIN` 设置为实际的完整 HTTPS 网站入口，例如 `https://your-project.edgeone.app`；使用 `https://www.wupanfeng.dpdns.org` 时可以沿用代码默认值。修改环境变量后重新部署。

访问 `/api/health` 可检查账号数据库能力；初始化步骤和错误码见上方“账号数据库初始化”。检查不创建账号，也不返回存储凭据。注册及修改密码使用相同的唯一约束检查，不支持条件写入时不会跳过保护。

自定义域名需在新项目的域名管理中绑定，DNS CNAME 必须使用新项目控制台显示的值。首页和 `/api/me` 都返回 EdgeOne 的 `404 NOT_FOUND` / “The site does not exist” 时，先检查生产部署是否成功以及域名绑定；这类响应不是注册接口返回的错误。首页正常、API 返回 404 时，检查是否误将输出目录设为只有前端的 `dist`。

如果 GitHub 关联创建了一个新项目，原直接上传项目的 Blob 不会自动迁移。保留旧项目，在旧网站导出 JSON 备份，再在新网站使用管理员账号导入菜谱。

## 直接上传新版

在原 EdgeOne Pages 项目中，新建生产部署，上传 artifacts/fengwei-edgeone-multiuser.zip 的整个 ZIP。根目录直接是 index.html，并包含 cloud-functions/api/[[default]].js。云函数和 SDK 已编译，无需在平台 npm install。

保留原项目、原 Blob 命名空间 fengwei-recipes、原域名与配置。重新部署代码不会清空菜谱。已有的服务器菜谱会继续使用，不需要再次导入预制菜谱。菜谱数量取决于后续添加和删除，以同步后的列表为准。

旧控制台若仅识别 node-functions，可使用 artifacts/fengwei-edgeone-multiuser-legacy.zip；不要将两个函数目录合并上传。

默认正式入口为 https://www.wupanfeng.dpdns.org。只有改域名或使用预览入口时，才需要将 PUBLIC_ORIGIN 设置为对应的完整 HTTPS 域名。无需设置 RECIPE_PASSWORD。

部署完成后重新打开网站，让 Service Worker 更新到 fengwei-shell-v7，再检查登录页是否出现“注册账号”。手机安装的旧桌面名称可能需要重新添加才能更新。

## 注册与登录

- 注册填写昵称、密码和确认密码。密码 8～128 个字符。
- 系统生成固定的唯一账号 ID，例如 usr_ 加 32 位字符；注册成功后自动登录并打开账号页。
- 昵称可以重复，登录使用账号 ID 和密码。账号页提供查看与复制 ID。
- 原账号 wupanfeng 和原密码继续可用，也可以使用账号页显示的 ID 登录。
- Cookie 默认保持登录 90 天，剩余不足 7 天时自动续期。服务器只保存加盐 scrypt 哈希；Cookie 中保存签名会话与用户 ID，未保存明文密码。
- 暂未提供修改密码、密码找回、修改昵称或管理员账号列表。

所有账号都能查看、新增、编辑和删除所有共享菜谱，这是本次明确选择的权限。共享菜谱接口仍要求登录。公开注册后，新注册账号也有这些权限。

## 迁移与收藏

原菜谱、照片与历史版本保持原有存储路径。旧版签名 Cookie 可以继续识别，首次使用自动升级会话，无需重新输入密码。

旧版菜谱中的全局 favorite 标记只映射到原账号。其他账号不会继承原账号的收藏。旧菜谱被其他账号修改时，服务器先保存原账号的收藏基线，再写共享内容；该基线永远不能覆盖之后的主动收藏或取消收藏。

新版收藏存储在 private/favorites/<用户ID>/ 下，账号资料在 private/users/ 下。收藏操作不会改变共享菜谱的版本或更新时间。历史版本页面显示当前账号的收藏状态，恢复菜谱不会恢复其他人的收藏。

备份包含全部共享菜谱和导出账号的收藏状态。导入时更新共享菜谱，并将文件里标记的收藏合并到当前账号，不清空已有收藏、不修改其他账号的收藏。

手机缓存包含所属账号 ID。切换账号时清理旧账号视图，重新读取当前账号；同浏览器其他标签页也会响应登录、退出和账号切换。离线只能查看最近同步的当前账号缓存，修改需要联网。新版首次使用需联网同步一次，以建立新的账号缓存。

## 部署后验证

1. 用原账号登录，确认旧菜谱、照片和原收藏仍可见。
2. 注册另一个账号，复制并保存账号 ID。
3. 确认新账号也能看到已有菜谱，但最初没有原账号的收藏。
4. 用新账号收藏一条菜谱，在另一台设备用同一账号 ID 登录，确认收藏存在。
5. 用原账号同步，确认收藏状态没有受新账号影响。
6. 修改一条测试菜谱，确认另一个账号同步后能看到修改。

本地接口、旧 Cookie 迁移、浏览器双账号、收藏隔离、切换账号、跨设备和离线检查均已通过。这不等于已经更新你的 EdgeOne 云端；上传后仍要执行上述真实云端验证。

## 存储与版本规则

菜谱与照片使用同源登录 API，接口响应禁止缓存。照片按内容摘要复用，每次共享菜谱保存和删除都保留独立版本。过期编辑会报冲突，草稿保留；真正同时编辑时双方版本保留，可通过历史恢复。

Blob SDK 0.0.18 的网关没有可靠的 onlyIfNew 原子写保证，因此账号与密码版本改用 Supabase PostgreSQL。`fengwei_account_records` 表通过 `(namespace, key)` 主键与 `ON CONFLICT DO NOTHING` 保证原子占用；普通菜谱、照片和收藏仍通过 Blob SDK 访问同一命名空间。注册与修改密码在运行时验证数据库条件写入，不可用时停止操作。注册请求使用随机请求编号，网络丢失后重试同一请求会返回相同账号，用户名仍唯一。收藏使用独立不可变事件，同一个账号的同时修改按事件顺序选择当前状态。

账户免费存储额度以控制台为准。历史版本和照片目前不会自动清理，建议定期导出备份。部署包不包含本地数据库、密码明文、个人备份或测试数据。

## 手机应用版本与打卡更新

本次更新沿用已有的 Supabase 表、Blob 命名空间与环境变量，无需再次执行建表脚本。打卡记录保存在已有 Supabase JSONB 表的 `private/cooking-checkins/` 路径，通过主键保证重试不重复。

`npm run build` 会根据前端文件自动生成版本号，将同一版本写入 `version.json`、`update.js` 和 `sw.js`；构建输出与 ZIP 中的版本一致。请上传整个构建目录或使用 GitHub 自动部署，避免单独替换其中一个文件。`version.json` 禁止缓存，Service Worker 检查绕过浏览器 HTTP 缓存，安装资源带版本参数。

新版本入口在登录页以及“我的 → 应用版本”。用户点击“检查更新”，再点击“更新并重新打开”。更新不会清除登录状态或菜谱缓存；有未提交的窗口时先保存或关闭。已有旧版主屏幕应用首次联网启动后请完全关闭，再次打开以进入带更新入口的新界面。下载不完整不会激活新界面，离线时继续使用原缓存。

## 本地检查

Node.js 20 或以上：npm install、npm run check、npm test、npm run build。

npm run dev 默认只监听 localhost:4173。本地文件数据库位于 .data/fengwei，云端使用 Blob 而非云函数临时磁盘。

浏览器检查：tests/browser-smoke.mjs 和 tests/browser-accounts.mjs。可通过 RECIPE_PLAYWRIGHT 和 RECIPE_BROWSER 指定本机运行库；测试使用独立临时目录与测试密码。

## 官方资料

- [直接上传](https://pages.edgeone.ai/document/direct-upload)
- [Node.js 云函数](https://pages.edgeone.ai/document/node-functions)
- [Blob 存储](https://pages.edgeone.ai/document/blob-storage)
- [Supabase API Keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [PostgREST Upsert](https://docs.postgrest.org/en/stable/references/api/tables_views.html#upsert)
