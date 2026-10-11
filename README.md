# 峰味 · 共享菜谱本

适合 iPhone 的中文网页 App。菜谱和照片保存在服务器，手机只保留离线查看缓存。支持注册、唯一账号 ID、Cookie 免登录、共享菜谱、独立收藏与跨设备读取、菜谱增删改、照片、搜索、分类、收藏、跟着做、历史版本恢复和 JSON 备份。

## 部署到 EdgeOne

完整操作见 [DEPLOY-EDGEONE.md](DEPLOY-EDGEONE.md)。

1. 本版支持注册，昵称与密码注册后会生成唯一账号 ID。原账号 wupanfeng 和原密码继续可用，无需设置 RECIPE_PASSWORD。
2. 在原直接上传项目中新建生产部署，上传 artifacts/fengwei-edgeone-multiuser.zip，保留原存储与域名。
3. 用 HTTPS 正式域名登录。保存一条菜谱，在另一台设备登录并同步，确认文字和照片可读。

上传包包含完整静态页面、已编译云函数和固定版本的存储 SDK。当前平台用 cloud-functions；旧版 node-functions 的兼容包见部署说明。私人 .env、本地数据库、测试数据和备份不会被打包。

从 GitHub 克隆源码后，先运行 `npm ci` 和 `npm run build`，生成上述 ZIP，再上传到原 EdgeOne 项目。生成物在 artifacts/ 下，不提交到 Git。代码包含原账号的服务端盐与密码哈希，仓库应保持私有；不包含明文密码、注册用户数据库或个人照片。

EdgeOne 的 Blob 持久化存储是服务端的轻量文档数据库。菜谱逐条保存，照片按内容摘要复用，版本记录独立保留。数据库不放在云函数的临时文件系统里，重新部署代码不会清空同项目、同命名空间的数据。此实现并不是 SQL/SQLite 数据库。

## 从拾味迁移

旧版 JSON 备份可以直接导入。相同网址、相同浏览器里已有本机数据时，备份页提供上传本机旧菜谱的入口。不同网址不能自动读取彼此的浏览器数据，要先导出、再导入。旧本机数据库名称保留 shiwei-private-recipes，以保护旧数据。

## 预制家常菜

presets/home-cooking-40.mjs 保存 40 道原创整理的家庭做法：家常菜 22 道、下饭菜 10 道、汤羹 8 道，均按约两人份记录。每道包含食材用量、步骤、用时与小贴士，可在菜谱本中继续编辑。

运行 `node scripts/build-presets.mjs` 生成 artifacts/峰味-40道家常菜.json。在“备份 → 选择备份文件 → 确认导入”使用现有功能即可，无需重新部署网页。预制菜谱使用固定编号，重复导入会跳过已有且较新的版本。

presets/extra-cooking-30.mjs 另收录 30 道家常菜与聚餐菜，包括糖醋排骨、剁椒鱼头、清蒸波龙、蒜蓉扇贝、姜葱炒蟹、梅菜扣肉等。多数约两人份，较大的菜按三至四人份标注。上述命令同时生成 artifacts/峰味-新增30道菜谱.json 和 artifacts/峰味-70道菜谱合集.json；所有预制菜谱默认不收藏。

scripts/seed-server.mjs 可向当前正式服务器添加这些菜谱。账号密码从隐藏的标准输入读取，不写入文件；脚本跳过已有编号和同名菜谱，写入后重新读取服务器验证。每次写入使用固定 mutationId，遇到平台请求正文读取失败时可安全重试。

新增批次使用 `node scripts/seed-server.mjs --input "artifacts/峰味-新增30道菜谱.json" --report "artifacts/extra-preset-import-verification.json"`。加 `--check-only` 只检查已有和待新增的菜谱，不写入。只添加菜谱数据时不需要重新部署 EdgeOne 代码。

## 本地开发

需要 Node.js 20 或更新版本：

```powershell
npm install
Copy-Item -LiteralPath .env.example -Destination .env
# 可选：在 .env 调整端口；账号密码已经配置
npm run dev
```

浏览器打开 http://localhost:4173。默认仅监听本机。需要局域网调试时可显式设置 RECIPE_HOST；手机的普通 HTTP 预览不支持离线安装。

本地开发使用 .data/fengwei 文件存储适配器，重启进程后保留数据；云端使用 EdgeOne Blob 适配器。目录位于公开 dist 之外，并已被 Git 忽略。

```powershell
npm run check
npm test
npm run build
```

自动浏览器检查：tests/browser-smoke.mjs 与 tests/browser-accounts.mjs，可通过 RECIPE_PLAYWRIGHT 和 RECIPE_BROWSER 指定 Playwright 与 Chromium 路径。测试使用独立演示数据与测试密码，不使用实际云端账户。

## 使用与限制

- 用 Safari 打开 HTTPS 网址，登录后添加到主屏幕。改名后原有桌面图标名称可能需要重新添加。
- 切换设备后使用同一网址和账号密码；点击同步菜谱读取服务器最新记录。目前没有自动推送。
- 离线可查看最近同步的菜谱；修改、删除、导入需要联网，保存失败时保留编辑器内容。不存在假装已上传的本地写入回退。
- 正常过期编辑会报版本冲突。真正同时保存时，双方独立版本保留并提示，通过历史版本恢复所需内容。界面展示最近 10 次版本，服务器历史目前不自动清理。
- 照片会压缩到最长边 1600 像素，上传照片的 Base64 数据限 3 MiB；单道菜文字 JSON 限 150,000 字节；备份导入文件限 50 MiB。网络中断时导入可能部分完成，错误中会显示已保存数量，剩余可重试。
- 免费 Blob 账户额度目前为 1 GB，以控制台为准。服务器数据仍需定期独立备份。所有账号可查看、新增、编辑和删除共享菜谱；收藏独立按账号保存。暂未提供密码找回、修改密码或昵称、视频或 AI 功能。
- 原账号配置与注册密码均使用加盐 scrypt 哈希；服务端签发 90 天 HttpOnly Cookie，临近到期时续期；HTTPS 下加 Secure。所有数据接口要求登录，并禁用 API 缓存。切换或退出账号时清理旧账号视图与缓存。旧版 Cookie 和原收藏会自动迁移。

## 文件

- dist/：前端界面、缓存适配与 PWA。
- server/database.mjs：文档数据库、照片与版本记录。
- server/api.mjs：认证、注册、校验和数据接口。
- server/accounts.mjs：唯一账号 ID、昵称与密码哈希。
- server/favorites.mjs：独立收藏与原账号收藏迁移。
- server/edgeone.mjs：EdgeOne Blob 云端适配。
- server/file-store.mjs：本地持久化适配。
- scripts/build-edgeone.mjs：编译云函数与 SDK、生成上传目录。
- DEPLOY-EDGEONE.md：生产环境设置、部署与迁移说明。

原先 chatgpt.site 发布的拾味没有在本次直接更新；它仍可用于导出旧菜谱。新版需要在自己的 EdgeOne 项目配置、上传并进行真实云端验证。
