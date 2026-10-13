# 完整备份与迁移

## 生成和保管

使用 **wupanfeng → 我的 → 菜谱备份 → 完整迁移备份**，输入两次至少 12 字符的独立备份口令，生成后下载全部 `.fengwei` 分卷。同批分卷放到单独目录；口令应另行保管，遗失无法解密。普通账号仍只能导出菜谱 JSON，不会接触账号或其他人的收藏。

完整备份保存以下业务数据：

- 全部账号、用户名预留、删除标记、密码盐和密码校验哈希、密码变更链；恢复后继续使用备份时的密码。
- 全部权限状态、授权申请和审批/撤销历史、密码找回申请与决定。
- 每个账号的收藏，所有菜谱版本和删除标记，独立图片对象、优化引用映射与状态。
- 备份时最近 7 天的操作日志，包括业务记录中的日志回执。

不复制部署凭据、Supabase 项目绑定、会话签名密钥和临时限流状态。目标站点使用自己的环境变量，用户需重新登录。被删除的账号不会因恢复而重新获得登录权限。菜谱历史保留全部版本（界面仍仅展示最近 10 条）。

传输接口仅管理员可访问、禁用缓存、每次校验账号。数据按 256 KiB 分块读取，完成后再次校验目录和每条记录的 SHA-256。检测到并发新增、删除或修改时整次生成失败。跨 Blob/SQL 的导出不是数据库事务：**正式迁移前停止源站写入，备份完成至切换期间也不要新增数据**，避免切换遗漏后续修改。

每卷明文上限 32 MiB，经过 gzip 后使用 AES-256-GCM 加密；口令经 PBKDF2-SHA256（250000 次、随机 16 字节盐）派生，每卷随机 12 字节 IV。分卷序号与批次通过附加认证数据绑定，文件上限 50 MiB。图片按存储对象去重，不在每个版本重复嵌入。生成过程目前使用浏览器内存，站点特别大时应在内存充足的电脑操作。

## 先校验，再恢复

需要 Node.js 22 及本仓库依赖 `npm ci`。把同批所有分卷放到一个目录，把备份口令放在一个只有自己可读的 UTF-8 文件中（权限 `600`，允许末尾换行）。不要把口令写进命令、Git、日志或发到聊天。

只校验，不连接或写入任何数据库：

```sh
node scripts/restore-full-backup.mjs --input /绝对路径/备份目录 --password-file /绝对路径/口令文件 --target check
```

恢复到新的本地目录，适合迁移演练：

```sh
node scripts/restore-full-backup.mjs --input /绝对路径/备份目录 --password-file /绝对路径/口令文件 --target local --local-dir /绝对路径/新的数据目录
```

随后使用 `RECIPE_DATA_DIR` 指向恢复目录运行 `npm run dev`。新目录不能包含其他数据。导入会校验账号密码链、菜谱历史及照片引用；错口令、损坏、漏卷、重复卷或混合批次会在任何业务写入之前拒绝。

## 恢复到新的 EdgeOne / Supabase

1. 建立目标项目并运行 `scripts/setup-supabase.sql`。创建**未被在线站点使用的空 Blob 命名空间和空账号 namespace**，暂不要切换正式域名。
2. 在受保护的终端环境中配置下面变量。Blob Token 来自目标项目，Supabase 使用目标项目的服务端密钥；不要使用浏览器公开密钥。

| 环境变量 | 作用 |
| --- | --- |
| `FENGWEI_RESTORE_PROJECT_ID` | 目标 EdgeOne 项目 ID |
| `FENGWEI_RESTORE_BLOB_TOKEN` | 目标项目 Blob 外部访问 Token |
| `FENGWEI_RESTORE_STORE_NAME` | 新的空 Blob namespace |
| `FENGWEI_RESTORE_SUPABASE_URL` | 目标 Supabase 项目 URL |
| `FENGWEI_RESTORE_SUPABASE_SECRET_KEY` | 目标 Supabase 服务端密钥 |
| `FENGWEI_RESTORE_ACCOUNT_NAMESPACE` | 新的空账号 namespace |

```sh
node scripts/restore-full-backup.mjs --input /绝对路径/备份目录 --password-file /绝对路径/口令文件 --target edgeone
```

3. 工具逐条写入并重新读取校验，完成后写入迁移完成标记；网络中断后用相同分卷和参数重试。只允许同一批次继续，不覆盖已存在的其他站点数据。未完成迁移的目标会返回 503，避免半份数据被当作在线站点使用。
4. 将目标部署的 `FENGWEI_STORE_NAME`、`FENGWEI_ACCOUNT_NAMESPACE`、`FENGWEI_SUPABASE_URL`、`FENGWEI_SUPABASE_SECRET_KEY` 指向对应目标值，部署同版本代码。检查管理员和普通用户登录、授权/撤销、各人收藏、照片、历史版本、7 天日志后再切换 `PUBLIC_ORIGIN` 和域名。
5. 保留源站与原备份以便回退。恢复发生在数周后时，早于恢复当日 7 天的日志会再次剔除，账号/菜谱历史不受影响。

备份无法代替站点代码、环境变量、域名和平台配置；这些需随迁移单独配置。不要将完整备份文件提交到公开仓库。

## 操作日志保留策略

日志列表、CSV/JSON 导出及完整备份统一按当前时间回溯 7×24 小时过滤。后台会**实际删除**过期的 Blob 原始日志、重试记录、Supabase 查询索引/规范记录，并从菜谱、权限、密码变更等业务版本中去除过期 `auditEntry`；业务版本本身不删除。旧回执不会被索引修复重新补回。

EdgeOne `schedules` 每天北京时间 03:15 调用 `/api/maintenance/audit`；访问日志页面也推进清理。清理分批、保存进度，历史数据较多时继续在下一次请求运行；过期记录从查询和导出中立即排除，物理删除在清理任务执行时完成。定时端点只接受固定保留策略，不接受调用者提供日期、路径或删除范围，有服务器持久限流，不返回业务数据。

已有数据库如未授予服务角色 DELETE 权限，需要由数据库管理员运行：

```sql
grant delete on public.fengwei_account_records to service_role;
```

这只用于服务端数据库角色，浏览器 `anon` 和 `authenticated` 仍无任何表访问权限。请在 EdgeOne 核对部署后的定时任务已创建；清理报错或任务中断应重试处理，不代表记录已从存储删除。
