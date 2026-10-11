# 拾味 · 私人菜谱本

为 iPhone 制作的中文 PWA，使用原生 HTML、CSS、JavaScript，无运行依赖、账号系统或服务器数据库。菜谱与照片保存到当前浏览器/网页 App 的 IndexedDB。

## 第一版功能

- 新增、编辑和删除菜谱；菜名、简介、自定义分类、用时、份量、食材、步骤和心得。
- 上传一张封面照片，自动缩放为最长边 1600 像素的 JPEG。
- 搜索菜名、食材和心得；分类筛选、收藏、按更新时间或菜名排序。
- “跟着做”逐步阅读；浏览器支持时尽量保持屏幕常亮。
- 下载或分享 JSON 备份，包含照片。导入前预览；同编号保留较新版本，其余菜谱保留。格式不合法时整份拒绝导入。
- HTTPS 或 localhost 下自动安装离线缓存，添加到桌面后可离线查看、编辑。
- 初始菜谱本为空。示例菜谱只有点击“先试试示例菜谱”后才会加入。

## 本地运行

需要 Node.js 20 或更新版本，无需 npm install。

```powershell
cd D:\Program\DevEcoStudioProjects\MyApplication\private-recipes
npm run dev
```

电脑访问 http://localhost:4173。手机与电脑连接同一 Wi-Fi 后，可访问控制台打印的 Network 地址；电脑需允许局域网连接 4173 端口。局域网 HTTP 只用于预览，不支持 Service Worker 离线安装。

```powershell
npm run check
npm test
```

## iPhone 使用

1. 用 Safari 打开部署后的 HTTPS 网址。
2. 分享 → 添加到主屏幕。若有“作为网页 App 打开”，请开启。
3. 从新建的桌面图标打开，再开始记录菜谱。
4. 第一次保持联网完整打开，在“备份”页确认“离线页面已准备好”。

Safari、其他浏览器、同一网站的不同桌面安装实例可能有独立数据。换浏览器、换网址或换设备时，先导出，再从目标实例导入。不要在私人浏览模式中保存长期菜谱。

导出文件可以保存到 iPhone“文件”或个人 iCloud 云盘。App 不会自动将菜谱同步到 iCloud。清除网站数据或系统回收本地存储可能导致丢失，请定期备份。导出文件包含私人照片与文字，应自行妥善保存。

## 免费静态托管

`dist/` 是完整成品，可直接部署到 GitHub Pages 或 Cloudflare Pages 等静态托管平台，无需构建。所有资源均使用相对路径，可放在域名根目录或子目录。

网站程序可以公开托管；每位访客的菜谱分别保存在自己的设备里。不要把个人备份 JSON 放进公开代码仓库。当前 Sites 发布默认只有所有者可访问；在线访问可能需要登录对应的 ChatGPT 账号。

更新资源后，请递增 `dist/sw.js` 的 `CACHE` 版本；已有页面关闭后，新缓存才会接管。浏览器缓存只保存应用代码和图标，菜谱保存在 IndexedDB。

## 文件

- `dist/index.html`：入口及 iPhone 桌面配置。
- `dist/app.js`：界面与交互。
- `dist/store.js`：本地数据库、备份校验、导入合并和查询。
- `dist/styles.css`：手机与电脑布局。
- `dist/sw.js`：应用资源离线缓存。
- `tests/store.test.mjs`：备份、校验、合并保护与查询测试。
- `scripts/serve.mjs`：无依赖本地预览服务器。

目前没有云同步、多人共享、视频、AI 菜谱或自动抓取功能。
