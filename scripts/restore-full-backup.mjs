import { readFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileStore } from '../server/file-store.mjs';
import { createAccountStore } from '../server/account-store.mjs';
import { readFullBackup, restoreFullBackup } from '../server/full-restore.mjs';

const args = process.argv.slice(2), flags = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--target', '--local-dir', '--password-file'].includes(args[i]) || !args[i + 1] || flags[args[i]]) throw new Error('用法：node scripts/restore-full-backup.mjs --input 备份目录 --password-file 口令文件 --target check|local|edgeone [--local-dir 新目录]');
  flags[args[i]] = args[i + 1];
}
if (!flags['--input'] || !flags['--password-file'] || !['check', 'local', 'edgeone'].includes(flags['--target'])) throw new Error('请指定备份目录、受保护的口令文件及目标 check/local/edgeone');
const directory = resolve(flags['--input']), names = (await readdir(directory)).filter(name => name.endsWith('.fengwei'));
if (!names.length) throw new Error('目录中没有 .fengwei 完整备份分卷');
let password = (await readFile(flags['--password-file'], 'utf8')).replace(/\r?\n$/, '');
const archive = await readFullBackup(await Promise.all(names.map(name => readFile(resolve(directory, name), 'utf8'))), password); password = '';
console.log(`备份校验通过：${archive.manifest.recordCount} 条记录，${names.length} 个分卷。`);
if (flags['--target'] !== 'check') {
  let store;
  if (flags['--target'] === 'local') {
    if (!flags['--local-dir']) throw new Error('本地恢复需要 --local-dir 新目录');
    await mkdir(resolve(flags['--local-dir']), { recursive: true, mode: 0o700 }); store = new FileStore(resolve(flags['--local-dir']));
  } else {
    const required = ['FENGWEI_RESTORE_PROJECT_ID', 'FENGWEI_RESTORE_BLOB_TOKEN', 'FENGWEI_RESTORE_STORE_NAME', 'FENGWEI_RESTORE_SUPABASE_URL', 'FENGWEI_RESTORE_SUPABASE_SECRET_KEY', 'FENGWEI_RESTORE_ACCOUNT_NAMESPACE'];
    if (required.some(name => !process.env[name])) throw new Error('请先设置文档中的全部 FENGWEI_RESTORE_* 目标环境变量');
    const { getStore } = await import('@edgeone/pages-blob');
    store = createAccountStore(getStore({ name: process.env.FENGWEI_RESTORE_STORE_NAME, projectId: process.env.FENGWEI_RESTORE_PROJECT_ID, token: process.env.FENGWEI_RESTORE_BLOB_TOKEN, consistency: 'strong' }), { url: process.env.FENGWEI_RESTORE_SUPABASE_URL, secretKey: process.env.FENGWEI_RESTORE_SUPABASE_SECRET_KEY, namespace: process.env.FENGWEI_RESTORE_ACCOUNT_NAMESPACE });
  }
  const result = await restoreFullBackup(store, archive, { onProgress: (count, total) => { if (count % 100 === 0 || count === total) console.log(`恢复并校验 ${count}/${total}`); } });
  console.log(`完整恢复通过，共 ${result.records} 条记录。请启动目标站点，使用备份中的账号密码登录验收后再切换域名。`);
}
