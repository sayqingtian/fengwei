import { makeBackupParts, createId } from './store.js';

export async function prepareBackup(store) {
  const snapshot = await store.backupSnapshot();
  const parts = makeBackupParts(snapshot.recipes, { exportedAt: snapshot.syncedAt });
  const stamp = snapshot.syncedAt.replace(/[.:]/g, '-'), id = createId().slice(0, 8);
  const files = parts.map((part, index) => ({
    file: new File([part.text], `峰味菜谱备份-${stamp}-${id}${parts.length > 1 ? `-第${index + 1}份-共${parts.length}份` : ''}.json`, { type: 'application/json' }),
    count: part.count, downloaded: false,
  }));
  return { userId: snapshot.userId, syncedAt: snapshot.syncedAt, total: snapshot.recipes.length, files };
}

export function backupExportPanel({ busy, error, prepared, lastBackup, esc, icon }) {
  return `<div class="panel-icon">${icon('download')}</div><h2>导出最新菜谱</h2><p>先联网同步全部菜谱、照片和我的收藏，再下载备份。同步失败时不会生成文件。</p><button class="button primary" data-action="export" ${busy ? 'disabled' : ''}>${busy ? '正在同步并生成…' : prepared ? '重新同步并生成备份' : '同步并生成备份'}</button><p class="small-note">每份最多 50 MiB、10000 道菜谱，超出时自动分卷。各份均可独立导入；完整恢复请导入全部分卷。</p>${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ''}${prepared ? `<section class="backup-ready" aria-label="已生成的备份"><p role="status">已生成 ${prepared.files.length} 份，合计 ${prepared.total} 道菜谱。<br>内容截至 ${esc(new Date(prepared.syncedAt).toLocaleString('zh-CN'))} 的同步结果。${prepared.files.length > 1 ? '<br>请逐份下载并保存全部文件。' : ''}</p><ul class="backup-files">${prepared.files.map(({ file, count, downloaded }, index) => `<li><strong>${prepared.files.length > 1 ? `第 ${index + 1} / ${prepared.files.length} 份` : '菜谱备份'} · ${count} 道 · ${(file.size / 1024 / 1024).toFixed(2)} MiB</strong><small>${esc(file.name)}</small><div class="management-actions"><button class="button ghost" data-action="download-backup-part" data-index="${index}">${downloaded ? '再次下载' : '下载备份'}${prepared.files.length > 1 ? `第 ${index + 1} 份` : ''}</button>${typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] }) ? `<button class="text-button" data-action="share-backup-part" data-index="${index}">分享到“文件”</button>` : ''}</div>${downloaded ? '<small>已发起保存，请确认文件已保存到设备。</small>' : ''}</li>`).join('')}</ul></section>` : ''}<p class="small-note">${lastBackup ? `上次已发起全部文件保存：${esc(new Date(lastBackup).toLocaleString('zh-CN'))}` : '还没有保存过备份'} · JSON 格式，包含照片</p>`;
}
