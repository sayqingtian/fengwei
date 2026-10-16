import { installBackNavigation } from './navigation.js';
import { createDraftStore } from './drafts.js';
import { APP_VERSION } from './version.js';
import { createUpdater } from './update.js';
import { checkinPages, pendingCheckins } from './checkins.js';
import { prepareFullBackup, fullBackupPanel } from './full-backup.js';
import { myPages, roleName } from './my.js';
import { recoveryPages } from './recovery.js';
import { emailFields, createEmailForms } from './email.js';
import { compressPhoto, optimizeDataPhoto, photoSize } from './photo.js';
import { imagePage } from './photos-page.js';
import { prepareBackup, backupExportPanel } from './backup.js';
import { CATEGORIES, createId, openStore, validateRecipe, filterRecipes, parseBackup, planImport, BACKUP_MAX_BYTES } from './store.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let accountDeletion = null;
let draftStore; try { draftStore = createDraftStore(localStorage); } catch {}
let draftTimer, draftProblem = '', trashData = null, trashError = '', trashBusy = false;
let retentionData = null, retentionError = '', retentionBusy = false;
let updateApplying = false;
let fullBackupGeneration = 0;
let fullBackupBusy = false, fullBackupProgress = '', fullBackupError = '', fullBackupPrepared = null;
let backupBusy = false, backupError = '', preparedBackup = null, backupGeneration = 0;
function resetBackup() { fullBackupGeneration++; fullBackupBusy = false; fullBackupProgress = ''; fullBackupError = ''; fullBackupPrepared = null; backupGeneration++; backupBusy = false; backupError = ''; preparedBackup = null; }
let imageData = null, imageBusy = false, imageStop = false, imageProgress = '', imageError = '', imageSaved = 0;
const paths = {
  bowl: '<path d="M3 11h18c-.6 6-4.1 9-9 9s-8.4-3-9-9Z"/><path d="M9 23h6M8 7c-3-3 3-3 0-6M13 7c-3-3 3-3 0-6"/>',
  book: '<path d="M4 3h13a3 3 0 0 1 3 3v15H6a3 3 0 0 1-3-3V6a3 3 0 0 1 1-3Z"/><path d="M7 3v14M3 17h17M11 7h5M11 10h4"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  backup: '<path d="M7 3h10l4 4v14H3V7l4-4Z"/><path d="M7 3v7h10V3M8 21v-6h8v6"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M17 4a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-3-5"/>',
  leaf: '<path d="M5 20C1 8 9 2 21 3c1 12-6 19-16 17ZM5 20 16 9"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4M10 5h4"/>',
  photo: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 5 5 3-3 4 4"/>',
  edit: '<path d="m15 4 5 5-11 11-6 1 1-6L15 4Zm0 0 2-2 5 5-2 2"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  share: '<path d="M12 15V2m-4 4 4-4 4 4M7 9H4v12h16V9h-3"/>',
  cloud: '<path d="M6 18a5 5 0 0 1-.6-10A7 7 0 0 1 19 7a5.5 5.5 0 0 1-1 11Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  wifi: '<path d="M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.book}</svg>`;
const my = myPages({ icon, esc });
const recoveryView = recoveryPages({ icon, esc });
const emailForms = createEmailForms(createId);
let emailBusy = false, emailMutationId = null;
const checkinView = checkinPages({ icon, esc });
const bowlArt = `<svg viewBox="0 0 140 140" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><ellipse cx="70" cy="60" rx="47" ry="14"/><path d="M23 60c4 40 21 55 47 55s43-15 47-55M53 120h34M56 36c-12-13 12-14 0-27M72 34c-12-13 12-14 0-27"/><path d="M83 53c-2-20 10-31 28-29 3 17-8 30-28 29Zm1-1 16-16"/></g><ellipse cx="67" cy="63" rx="33" ry="7" fill="currentColor" opacity=".15"/></svg>`;
const heroArt = `<svg viewBox="0 0 360 270" aria-hidden="true"><ellipse cx="185" cy="240" rx="144" ry="13" fill="#e9ebdf"/><g transform="rotate(-9 171 149)"><rect x="78" y="45" width="178" height="194" rx="9" fill="#cdd8b4"/><rect x="89" y="42" width="161" height="187" rx="5" fill="#fffdf1" stroke="#dfe2ce"/><path d="M109 42v187" stroke="#dacdb9" stroke-width="1.3"/><path d="M132 77h94M132 95h55M132 170h87M132 188h76M132 205h88" stroke="#dce1cf" stroke-width="3" stroke-linecap="round"/><text x="132" y="148" fill="#647b56" font-family="serif" font-size="28">好好吃饭</text><g fill="none" stroke="#6f8260" stroke-width="3"><path d="M100 65c-22-11-22 10 0 9M100 104c-22-11-22 10 0 9M100 143c-22-11-22 10 0 9M100 182c-22-11-22 10 0 9"/></g></g><g transform="rotate(12 278 166)"><path d="M268 97h14v128l-7 16-7-16Z" fill="#c88b58"/><path d="M270 103h4v122" stroke="#eccca6" stroke-width="3"/><path d="m268 225 7 16 7-16" fill="#e7d4a7"/><path d="m272 235 3 6 3-6" fill="#4b5c43"/></g><g fill="#8f9f70"><path d="M281 81c-10-38 18-60 49-54-2 34-20 55-49 54Z"/><path d="M286 82c26-4 44 11 47 35-24 5-44-7-47-35Z"/></g><path d="m275 101 39-62M287 83l31 22" stroke="#526d49" stroke-width="2" fill="none"/><circle cx="65" cy="211" r="23" fill="#c9754c"/><path d="m53 192 12 5 9-7-4 11 10 6-13-1-7 8 1-12Z" fill="#6d8359"/><path d="M52 217c2 6 6 8 11 9" stroke="#dfaa83" stroke-width="3" stroke-linecap="round" fill="none"/><path d="m42 101 3 6 7 1-6 5 1 7-6-4-6 4 1-7-5-5 7-1Z" fill="#d2bb8e"/><path d="M302 196h12m-6-6v12" stroke="#b3ba91" stroke-width="2" stroke-linecap="round"/></svg>`;

let db, recipes = [], page = 'recipes', category = '全部', query = '', sort = 'updated';
let editor = null, detailId = null, cookStep = null, pendingImport = null, lastBackup = null;
let toastTimer, confirmResolve, restoreFocus, wakeLock = null, offlineReady = false;
let historyItems = [], legacyCount = 0, registrationId = null, authBusy = false;
let permissionData = null, permissionError = '', permissionRequestId = createId(), permissionDecision = null;
let auditData = null, auditQuery = '', auditResult = '', auditFrom = '', auditTo = '', auditError = '', auditLoading = false;
let passwordMutationId = null, passwordBusy = false, auditExportBusy = false;
let recoveryRequestId = null, recoveryData = null, recoveryError = '', recoveryLoading = false, recoveryDecision = null, recoveryBusy = false;
let checkinDraft = null, checkinBusy = false, checkinData = null, checkinLoading = false, checkinError = '', checkinGeneration = 0, checkinReload = false, checkinRevision = 0;
let recipeLoading = false, recipeLoadError = '', loginTimer, refreshGeneration = 0;
const updater = createUpdater({ changed: renderUpdateControls });
let modalLayer = null, modalParent = null, pageParents = [], modalSequence = 0;
const rootPages = ['recipes', 'favorites', 'my'];
const backNavigation = installBackNavigation({ target: window,
  canBack: () => !!db?.user && !$('#auth-root').hasChildNodes() && (!!modalLayer || !rootPages.includes(page)),
  back: goBack, report: error => toast(errorText(error)),
});
async function goBack() {
  if (confirmResolve) { confirmResolve(false); return; }
  if (modalLayer) {
    const parent = modalParent;
    await closeModal();
    if (!modalLayer && parent && findRecipe(parent.id)) {
      showDetail(parent.id); $('.modal-scroll').scrollTop = parent.scroll;
    }
    return;
  }
  const previous = pageParents.pop() || { page: 'my', query: '', category: '全部', scroll: 0 };
  page = previous.page; query = previous.query; category = previous.category;
  render(); window.scrollTo(0, previous.scroll);
}
async function navigate(next) {
  if ($('#modal-root').hasChildNodes()) { await closeModal(); if ($('#modal-root').hasChildNodes()) return; }
  if (next === page) return;
  if (rootPages.includes(next)) pageParents = [];
  else pageParents.push({ page, query, category, scroll: window.scrollY });
  page = next; query = ''; category = '全部'; pendingImport = null; render(); window.scrollTo(0, 0);
  if (page === 'checkins') await loadCheckins();
  if (page === 'permissions') await loadPermissions();
  if (page === 'logs') { await loadLogs(); await loadRetention(); }
  if (page === 'images') await loadImages();
  if (page === 'trash') await loadTrash();
  if (page === 'recovery' || (page === 'my' && db.user?.role === 'admin')) await loadRecoveries();
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('fengwei-changes') : null;
const date = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value));
const errorText = error => error?.name === 'QuotaExceededError' ? '手机存储空间不足，未能保存。请释放空间后重试。' : error?.message || '操作未完成，请重试';
const findRecipe = id => recipes.find(item => item.id === id);

function readDrafts() {
  try { return draftStore?.list(db?.user?.id) || []; } catch (error) { draftProblem = errorText(error); return []; }
}
function draftNotice() {
  if (!['recipes', 'favorites'].includes(page) || !db?.user) return '';
  const count = readDrafts().length;
  return count ? `<div class="sync-warning">此设备有 ${count} 份未提交草稿。<button class="text-button" data-action="navigate" data-page="drafts">继续编辑</button></div>` : '';
}
function draftRecipe() {
  const form = $('#recipe-form'); if (!editor || !form) return null;
  const fields = new FormData(form);
  return { ...editor.recipe, title: fields.get('title'), description: fields.get('description'), category: fields.get('category'), minutes: fields.get('minutes'), servings: fields.get('servings'), notes: fields.get('notes'), ingredients: [...form.querySelectorAll('.ingredient-row')].map(row => ({ name: $('.ingredient-name-input', row).value, amount: $('.ingredient-amount-input', row).value })), steps: [...form.querySelectorAll('.step-input')].map(input => input.value) };
}
function saveDraftNow() {
  clearTimeout(draftTimer);
  if (!editor?.dirty || editor.saving) return true;
  const recipe = draftRecipe(); if (!recipe) return true;
  try {
    if (!draftStore) throw new Error('浏览器不允许保存本机草稿，请保持页面打开并及时保存到服务器。');
    draftStore.save(editor.userId, { recipe, baseRevision: editor.baseRevision, isNew: editor.isNew });
    draftProblem = ''; if ($('#draft-status')) $('#draft-status').textContent = '草稿已保存在此设备，尚未提交到服务器。';
    return true;
  } catch (error) {
    draftProblem = errorText(error);
    if ($('#draft-status')) $('#draft-status').textContent = `草稿未能保存：${draftProblem}`;
    return false;
  }
}
function markDraftDirty() {
  if (!editor) return;
  editor.dirty = true; clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 250);
}
function removeDraft(owner, id) {
  clearTimeout(draftTimer);
  try { draftStore?.remove(owner, id); } catch { toast('菜谱已保存，但旧草稿未能清理，请稍后在本机草稿中删除。'); }
}
function clearEditorMemory() {
  refreshGeneration++; recipeLoading = false; checkinGeneration++; checkinLoading = false; checkinReload = false; checkinData = null; checkinError = ''; checkinDraft = null; checkinBusy = false;
  clearTimeout(draftTimer); editor = null; detailId = null; cookStep = null; modalLayer = null; modalParent = null; pageParents = []; modalSequence++;
  passwordBusy = false; recoveryBusy = false; passwordMutationId = null;
  confirmResolve?.(false); $('#modal-root').innerHTML = ''; document.body.classList.remove('locked');
  stopWakeLock().catch(() => {});
}
function draftsPage() {
  const items = readDrafts();
  return `${my.back()}<h1 class="page-title">本机草稿</h1><p class="page-lead">只有当前账号可以在此设备找回。草稿尚未同步，退出登录会清理；提交后自动移除。</p>${draftProblem ? `<p class="form-error" role="alert">${esc(draftProblem)}</p>` : ''}<section class="panel version-list">${items.map(item => `<article><h2>${esc(item.recipe.title || '还没取名的菜谱')}</h2><p>${esc(new Date(item.savedAt).toLocaleString('zh-CN'))} · ${item.isNew ? '新菜谱' : '未提交修改'}</p><div class="management-actions"><button class="button primary" data-action="resume-draft" data-id="${esc(item.recipe.id)}" ${db?.canEdit ? '' : 'disabled'}>继续编辑</button><button class="button ghost" data-action="discard-draft" data-id="${esc(item.recipe.id)}">删除草稿</button></div></article>`).join('') || '<p class="empty-management">此设备没有未提交的草稿。</p>'}</section>${items.length && !db?.canEdit ? '<p class="permission-note">联网并获得编辑权限后可继续编辑；现有草稿仍保留。</p>' : ''}`;
}
function trashPage() {
  return `${my.back()}<div class="section-head"><h1 class="page-title">回收站</h1><button class="button ghost" data-action="reload-trash" ${trashBusy ? 'disabled' : ''}>刷新回收站</button></div><p class="page-lead">删除的共享菜谱保留在这里。恢复会生成新版本；彻底删除会移除菜谱及全部历史，无法撤销。同时清理未被其他菜谱或历史版本使用的图片，释放存储空间。</p>${trashError ? `<p class="form-error" role="alert">${esc(trashError)}</p>` : ''}<section class="panel version-list">${trashData?.items.map(item => `<article><h2>${esc(item.title)}</h2><p>删除于 ${esc(new Date(item.deletedAt).toLocaleString('zh-CN'))}</p><div class="management-actions"><button class="button primary" data-action="restore-trash" data-id="${esc(item.id)}" ${!item.purging && item.version && db?.canEdit ? '' : 'disabled'}>恢复菜谱</button><button class="button ghost" data-action="history" data-id="${esc(item.id)}" ${item.purging ? 'disabled' : ''}>查看历史</button><button class="button danger" data-action="purge-trash" data-id="${esc(item.id)}">${item.purging ? '继续彻底删除' : '彻底删除'}</button></div></article>`).join('') || `<p class="empty-management">${trashBusy ? '正在读取回收站…' : '回收站为空。'}</p>`}${trashData?.cursor ? '<button class="button ghost" data-action="load-more-trash">加载更多</button>' : ''}</section>`;
}
async function loadTrash(more = false) {
  if (trashBusy || !db?.canEdit) return;
  const owner = db.user.id; trashBusy = true; trashError = ''; render();
  try {
    const result = await db.trash(more ? trashData?.cursor || '' : '');
    if (db.user?.id !== owner) return;
    trashData = { ...result, items: more ? [...trashData.items, ...result.items] : result.items };
    // Sparse pages may contain only active recipes; continue until there is something to show.
    while (!trashData.items.length && trashData.cursor) {
      const next = await db.trash(trashData.cursor); if (db.user?.id !== owner) return;
      trashData = next;
    }
  } catch (error) { trashError = errorText(error); }
  finally { trashBusy = false; if (page === 'trash' && db.user?.id === owner) render(); }
}
async function restoreTrash(id) {
  const item = trashData?.items.find(row => row.id === id); if (!item?.version) return;
  if (!await ask('恢复这道菜？', `“${item.title}”会重新出现在所有账号的共享菜谱本中。`, '确认恢复')) return;
  const [version] = await db.history(id, item.version);
  if (!version?.recipe) throw new Error('历史版本暂时不可用，请刷新回收站。');
  await db.put(version.recipe, { baseRevision: item.revision, operation: 'restore' });
  await changed(); await loadTrash(); showDetail(id); toast('菜谱和照片已恢复');
}
async function purgeTrash(id) {
  const item = trashData?.items.find(row => row.id === id); if (!item) return;
  if (!await ask('彻底删除这道菜？', `“${item.title}”的菜谱内容和所有历史版本都将永久移除，所有账号均无法恢复。未被其他菜谱或历史版本使用的图片也会一并清理。已下载的备份不受影响。`, '彻底删除', true)) return;
  const mutationId = createId();
  try {
    let result;
    do { result = await db.purgeRecipe(id, item.revision, mutationId); } while (!result.complete);
    await refresh(); await loadTrash(); toast('菜谱及全部历史版本已彻底删除');
  } catch (error) { await loadTrash(); throw error; }
}
function retentionPanel() {
  if (db?.user?.role !== 'admin') return '';
  const data = retentionData, when = value => value ? esc(new Date(value).toLocaleString('zh-CN')) : '尚无记录';
  return `<details class="panel retention-panel"><summary>过期日志清理<span>自动保留 7 天</span></summary><p>${retentionBusy ? '正在处理本批，剩余记录会由自动任务继续清理…' : data?.error ? esc(data.error) : data?.complete ? '上一轮已完成，自动任务会定期检查。' : data?.startedAt ? `处理中：已检查 ${data.processed} 条，完成 ${data.stagesDone}/${data.stagesTotal} 类记录。` : '等待自动任务执行，可点击继续清理。'}</p><p class="small-note">最近检查：${when(data?.lastAttemptAt)}<br>最近完成：${when(data?.lastCompletedAt)}${data?.failedAt ? `<br>最近失败：${when(data.failedAt)}` : ''}</p>${retentionError ? `<p class="form-error" role="alert">${esc(retentionError)}</p>` : ''}<div class="management-actions"><button class="button ghost" data-action="reload-retention" ${retentionBusy ? 'disabled' : ''}>刷新状态</button><button class="button ghost" data-action="clean-audit" ${retentionBusy ? 'disabled' : ''}>继续清理</button></div></details>`;
}
async function loadRetention() {
  if (db?.user?.role !== 'admin') return;
  const owner = db.user.id;
  try { const data = await db.retention(); if (db.user?.id === owner) { retentionData = data; retentionError = ''; } }
  catch (error) { retentionError = errorText(error); }
  if (page === 'logs' && db.user?.id === owner) render();
}
async function cleanAudit() {
  if (retentionBusy || db?.user?.role !== 'admin') return;
  retentionBusy = true; retentionError = ''; render();
  try {
    const result = await db.cleanAudit();
    toast(result.complete ? '过期日志已清理完成' : '本批已完成，自动任务会继续处理剩余记录');
  } catch (error) { retentionError = errorText(error); }
  finally { retentionBusy = false; const problem = retentionError; await loadRetention(); retentionError = problem; if (page === 'logs') render(); }
}
function renderUpdateControls() {
  const state = updater.state;
  const banner = $('#update-root');
  if (banner) banner.innerHTML = state.available ? `<div class="update-banner"><span>新版本已就绪</span><button class="button primary" data-action="apply-update" ${state.busy ? 'disabled' : ''}>更新应用</button></div>` : '';
  document.querySelectorAll('[data-version-controls]').forEach(root => {
    root.innerHTML = `<span class="small-note">当前版本 ${esc(state.version)}</span><div class="version-actions"><button class="text-button" data-action="check-update" ${state.busy || authBusy ? 'disabled' : ''}>${state.busy ? '检查 / 更新中…' : '检查更新'}</button>${state.available ? `<button class="button primary" data-action="apply-update" ${state.busy || authBusy ? 'disabled' : ''}>更新并重新打开</button>` : ''}</div><p class="small-note version-status" role="status">${esc(state.status || '添加到主屏幕后，也可以在这里主动更新。')}</p>`;
  });
}

async function applyUpdate() {
  if (updateApplying || updater.state.busy) return;
  if (authBusy || passwordBusy || recoveryBusy || emailBusy || checkinBusy || editor?.saving || editor?.processingPhoto || imageBusy || backupBusy || fullBackupBusy || retentionBusy) { toast('请等待当前操作完成后更新。'); return; }
  if (!saveDraftNow()) { toast('本机草稿未能保存，请先将菜谱保存到服务器后更新。'); return; }
  const formHasInput = [...document.querySelectorAll('input:not([type="hidden"]), textarea')].some(field => field.value && !field.readOnly);
  if ((editor?.dirty || formHasInput || preparedBackup || fullBackupPrepared || pendingImport) && !await ask('更新应用？', editor?.dirty ? '菜谱草稿已保存在此设备，更新后可在“我的 → 本机草稿”继续编辑。' : '请先完成正在填写的表单，或下载已生成的备份。更新会重新打开页面。', '现在更新')) return;
  updateApplying = true;
  // Avoid a duplicate beforeunload dialog after the user has confirmed and the draft is saved.
  if (editor) editor.dirty = false;
  try { await updater.apply(); } finally { updateApplying = false; }
}

function showCheckin(id) {
  const recipe = findRecipe(id); if (!recipe || checkinBusy) return;
  if (db.readOnly || navigator.onLine === false) { toast('打卡需要联网，请联网同步后再提交。'); return; }
  if (db.syncJobs?.some(job => job.id === id && job.kind === 'recipe')) { toast('这道菜正在同步，请同步完成后再打卡。'); return; }
  checkinDraft = { recipeId: id, mutationId: createId(), expectedUserId: db.user.id };
  detailId = id; cookStep = null; stopWakeLock();
  showModal(checkinView.form(recipe), 'checkin', id);
  modalParent = { id, scroll: 0 };
}

async function submitCheckin(form) {
  if (checkinBusy || !checkinDraft || !form.reportValidity()) return;
  const draft = checkinDraft, error = $('#checkin-error'), button = $('[form="checkin-form"]');
  checkinBusy = true; form.inert = true; error.hidden = true; button.disabled = true; button.textContent = '正在保存打卡…';
  try {
    await db.queueCheckin({ ...draft, note: form.elements.note.value }, findRecipe(draft.recipeId)?.title || '下厨记录');
    checkinDraft = null; checkinBusy = false;
    showDetail(draft.recipeId); toast('打卡已保存在本机，正在后台同步。可以继续浏览。');
  } catch (problem) { if (form.isConnected) { error.textContent = errorText(problem); error.hidden = false; } }
  finally { checkinBusy = false; form.inert = false; button.disabled = false; button.textContent = '提交打卡'; }
}

async function loadCheckins(more = false) {
  if (checkinLoading) { checkinReload = true; return; }
  const userId = db.user?.id, generation = ++checkinGeneration, revision = checkinRevision; checkinLoading = true; checkinError = ''; render();
  try {
    const data = await db.checkins(more ? checkinData?.cursor : '');
    if (userId !== db.user?.id || generation !== checkinGeneration) return;
    if (revision !== checkinRevision) { checkinReload = true; return; }
    checkinData = { ...data, items: more && checkinData ? [...new Map([...checkinData.items, ...data.items].map(item => [item.id, item])).values()] : data.items };
  } catch (error) { if (userId === db.user?.id && generation === checkinGeneration) checkinError = errorText(error); }
  finally { if (generation === checkinGeneration) { checkinLoading = false; if (page === 'checkins') render(); if (checkinReload) { checkinReload = false; if (page === 'checkins') loadCheckins(); } } }
}
function visibleCheckins() { return pendingCheckins(checkinData, db?.syncJobs || []); }
async function deleteCheckin(id) {
  const item = visibleCheckins()?.items.find(item => item.id === id), owner = db.user?.id;
  if (!item || !await ask('删除这次打卡？', `将删除“${item.title}”这次打卡及心得，菜谱本身会保留。`, '删除打卡', true)) return;
  if (owner !== db.user?.id) return;
  await db.queueDeleteCheckin(item); render(); toast('删除已保存在本机，正在后台同步。');
}

function focusInitialField(field, heading) {
  // Touch users choose when to open the keyboard; keep desktop keyboard navigation.
  const touchLayout = matchMedia('(max-width: 760px), (any-pointer: coarse)').matches;
  (touchLayout ? heading : field || heading)?.focus({ preventScroll: true });
}

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 3600);
}

function nav(mobile = false) {
  return `<nav class="${mobile ? 'mobile-nav' : 'desktop-nav'}" aria-label="${mobile ? '底部' : '主'}导航">${[['recipes', 'book', '菜谱本'], ['favorites', 'heart', '收藏夹'], ['my', 'people', '我的']].map(([id, mark, name]) => `<button class="nav-item ${(page === id || (id === 'my' && ['backup', 'account', 'permissions', 'logs', 'recovery', 'images', 'trash', 'drafts', 'sync', 'checkins'].includes(page))) ? 'active' : ''}" data-action="navigate" data-page="${id}" ${(page === id || (id === 'my' && ['backup', 'account', 'permissions', 'logs', 'recovery', 'images', 'trash', 'drafts', 'sync', 'checkins'].includes(page))) ? 'aria-current="page"' : ''}>${icon(mark)}<span>${name}</span></button>`).join('')}</nav>`;
}

function render() {
  $('#app').innerHTML = `<a class="skip-link" href="#main">跳到菜谱内容</a><div class="shell"><header class="header"><div class="brand"><div class="brand-icon">${icon('bowl')}</div><div><div class="brand-name">峰味</div><div class="brand-caption">共享菜谱，自己的收藏</div></div></div>${nav()}<span class="private-pill">${icon('people')}共享菜谱 · 独立收藏</span></header><div id="sync-status">${syncBar()}</div><main id="main">${draftNotice()}${page === 'sync' ? syncPage() : page === 'drafts' ? draftsPage() : page === 'trash' ? trashPage() : page === 'my' ? my.overview(db?.user, recipes.filter(item => item.favorite).length, recoveryData?.requests.filter(item => item.status === 'pending').length || 0) : page === 'checkins' ? my.back() + checkinView.history(visibleCheckins(), { loading: checkinLoading, error: checkinError }) : page === 'backup' ? my.back() + backupPage() : page === 'account' ? my.back() + accountPage() : page === 'permissions' ? my.permissions(db?.user, permissionData, permissionError) : page === 'recovery' ? my.back() + recoveryView.inbox(db?.user, recoveryData, { error: recoveryError, loading: recoveryLoading }) : page === 'images' ? my.back() + imagePage({ user: db?.user, data: imageData, busy: imageBusy, progress: imageProgress, error: imageError, saved: imageSaved }) : page === 'logs' ? my.logs(db?.user, auditData, { query: auditQuery, result: auditResult, from: auditFrom, to: auditTo, error: auditError, loading: auditLoading, exporting: auditExportBusy, retention: retentionPanel() }) : recipePage()}</main><footer class="footer"><span>一餐一饭，都是生活的小事。</span><span>${icon('leaf')}把好味道分享给彼此 · v${APP_VERSION}</span></footer></div>${nav(true)}`;
  if (['recipes', 'favorites'].includes(page)) renderResults();
  renderUpdateControls();
  backNavigation.sync();
}

function syncBar() {
  if (!db?.authenticated) return `<div class="sync-bar" role="status"><span>${icon('lock')}${recipeLoading ? '正在恢复登录，请稍候…' : '登录尚未恢复，请重新加载或登录。'}</span>${recipeLoading ? '' : '<button class="text-button" data-action="auth-login">登录账号</button>'}</div>${queueNotice()}`;
  return `${db?.cacheWarning ? '<div class="sync-warning">手机本机存储暂时不可用，未同步内容请勿清理。请释放存储空间或允许网站保存数据。</div>' : ''}<div class="sync-bar"><span>${icon((db?.readOnly || navigator.onLine === false) ? 'wifi' : 'cloud')}${(db?.readOnly || navigator.onLine === false) ? '离线预览 · 修改需要联网' : `已登录：${esc(db?.user?.displayName || '')} · ${roleName(db?.user)}`}</span><div><button class="text-button" data-action="sync">同步菜谱</button><button class="text-button" data-action="logout">退出</button></div></div>${recipeLoading ? '<p class="sync-loading" role="status"><span class="loading-ring" aria-hidden="true"></span>正在加载最新菜谱与照片…</p>' : ''}${queueNotice()}${db?.conflicts.length ? `<div class="sync-warning">检测到同时编辑的版本，内容均已保留。<button class="text-button" data-action="history" data-id="${esc(db.conflicts[0])}">查看历史版本</button></div>` : ''}`;
}

function detailSyncStatus(id) {
  const jobs = db?.syncJobs.filter(job => job.id === id) || [];
  return jobs.length ? `${jobs.some(job => job.status === 'failed') ? '同步未完成，修改保留在本机。' : '已保存在本机，正在后台同步。'}<button class="text-button" data-action="navigate" data-page="sync">查看同步状态</button>` : '已同步到服务器';
}
function queueNotice() {
  const jobs = db?.syncJobs || [], failed = jobs.filter(job => job.status === 'failed').length;
  return jobs.length ? `<div class="sync-warning" role="status">${failed ? `${failed} 项同步失败，内容仍在本机` : `${jobs.length} 项修改已保存在本机，后台同步中`}<button class="text-button" data-action="navigate" data-page="sync">查看后台同步</button></div>` : '';
}
function syncPage() {
  const jobs = db?.syncJobs || [];
  return `${my.back()}<div class="section-head"><h1 class="page-title">后台同步</h1><button class="button ghost" data-action="retry-sync">立即重试</button></div><p class="page-lead">操作会先保存在此设备，再上传到服务器。网络恢复后自动重试；关闭页面后会暂停，下次打开并登录原账号继续。同步完成前请勿清理网站数据。</p><section class="panel version-list">${jobs.map(job => `<article><h2>${esc(job.title)}</h2><p>${({ recipe: '保存菜谱', checkin: '提交打卡', 'checkin-delete': '删除打卡' })[job.kind] || (job.value.favorite ? '收藏' : '取消收藏')} · ${job.status === 'failed' ? '需要处理' : job.status === 'sending' ? '正在同步' : '等待同步'}</p>${job.error ? `<p class="small-note">${esc(job.error)}</p>` : ''}${job.status === 'failed' ? `<div class="management-actions">${job.recipe ? `<button class="button ghost" data-action="copy-sync" data-token="${esc(job.token)}">另存为新菜</button>` : ''}<button class="button ghost" data-action="discard-sync" data-token="${esc(job.token)}">放弃本机修改</button></div>` : ''}</article>`).join('') || '<p class="empty-management">所有修改已同步完成。</p>'}</section>`;
}
function updateQueueView() {
  if (!db) return;
  const signature = items => items.map(item => `${item.id}:${item.updatedAt}:${item.favorite}`).join('|');
  const before = signature(recipes); recipes = db.current();
  if ($('#favorite-count')) $('#favorite-count').textContent = String(recipes.filter(item => item.favorite).length);
  if ($('#detail-sync-status')) $('#detail-sync-status').innerHTML = detailSyncStatus(detailId);
  if ($('#sync-status')) $('#sync-status').innerHTML = syncBar();
  if (before !== signature(recipes) && ['recipes', 'favorites'].includes(page) && $('#results')) renderResults();
  if (page === 'sync') $('#main').innerHTML = syncPage();
  if (page === 'checkins') $('#main').innerHTML = my.back() + checkinView.history(visibleCheckins(), { loading: checkinLoading, error: checkinError });
  for (const button of document.querySelectorAll('[data-action="favorite"]')) {
    const selected = !!findRecipe(button.dataset.id)?.favorite;
    button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-label', `${selected ? '取消收藏' : '收藏'} ${findRecipe(button.dataset.id)?.title || ''}`);
  }
}
function showLogin(message = '登录查看所有共享菜谱，收藏夹只记录你喜欢的菜。', mode = 'login') {
  $('#app').inert = true; $('#modal-root').inert = true;
  const register = mode === 'register';
  if (register) registrationId = createId();
  $('#auth-root').innerHTML = `<div class="auth-overlay"><section class="auth-panel" role="dialog" aria-modal="true" aria-labelledby="auth-title"><span class="boot-mark">峰味</span><h1 id="auth-title">${register ? '注册自己的账号' : '打开共享菜谱本'}</h1><p>${esc(message)}</p><div class="auth-tabs" role="group" aria-label="登录或注册"><button class="${register ? '' : 'active'}" data-action="auth-login" aria-pressed="${!register}">登录账号</button><button class="${register ? 'active' : ''}" data-action="auth-register" aria-pressed="${register}">注册账号</button></div><form id="${register ? 'register-form' : 'login-form'}" data-email-purpose="${register ? 'register' : ''}">${register ? '<label class="field"><span class="field-label">用户名</span><input id="register-name" name="displayName" type="text" autocomplete="username" required maxlength="30" placeholder="设置唯一用户名"></label>' + emailFields() : `<label class="field"><span class="field-label">账号</span><input id="login-username" name="username" type="text" autocomplete="username" required maxlength="64" placeholder="用户名或账号 ID" autocapitalize="none" spellcheck="false"></label>`}<label class="field"><span class="field-label">密码</span><input id="access-password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required ${register ? 'minlength="8" maxlength="128" placeholder="设置至少 8 位密码"' : 'maxlength="256" placeholder="输入密码"'}></label>${register ? '<label class="field"><span class="field-label">确认密码</span><input id="register-confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="128" placeholder="再次输入密码"></label><p class="small-note">用户名只能注册一次，不区分大小写和首尾空格。验证邮箱后即可注册，可用用户名或账号 ID 登录。</p>' : ''}<p id="login-error" class="form-error" role="alert" hidden></p><button class="button primary" type="submit">${register ? '注册并登录' : '打开菜谱本'}</button></form>${!register ? '<button class="text-button recovery-back" data-action="auth-recovery">忘记密码？</button>' : ''}<div data-version-controls class="version-controls"></div><p class="small-note">保持登录 90 天。普通账号默认仅可查看菜谱，编辑需要管理员授权；收藏各自独立。</p></section></div>`;
  $('#auth-title').tabIndex = -1;
  renderUpdateControls();
  focusInitialField(register ? $('#register-name') : $('#login-username'), $('#auth-title'));
}

function showRecoveryRequest() {
  if (emailBusy) return;
  emailMutationId = createId();
  $('#app').inert = true; $('#modal-root').inert = true;
  $('#auth-root').innerHTML = recoveryView.emailRequest();
  $('#auth-title').tabIndex = -1;
  focusInitialField($('#email-recovery-form [name="username"]'), $('#auth-title'));
}

function showManualRecoveryRequest() {
  recoveryRequestId = createId();
  $('#app').inert = true; $('#modal-root').inert = true;
  $('#auth-root').innerHTML = recoveryView.request();
  $('#auth-title').tabIndex = -1;
  focusInitialField($('#password-recovery-form [name="username"]'), $('#auth-title'));
}

async function submitRecoveryRequest(form) {
  if (authBusy || !form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]'), error = $('#recovery-error');
  authBusy = true; form.inert = true; button.disabled = true; button.textContent = '正在发送…'; error.hidden = true;
  try {
    const data = await db.requestPasswordRecovery({ ...Object.fromEntries(new FormData(form)), requestId: recoveryRequestId });
    form.reset(); $('#auth-root').innerHTML = recoveryView.request(data.message);
    $('#auth-root [data-action="auth-login"]').focus();
  } catch (problem) {
    error.textContent = errorText(problem); error.hidden = false;
    form.inert = false; button.disabled = false; button.textContent = '发送找回申请';
  } finally { authBusy = false; }
}

async function login(form) {
  if (authBusy || emailBusy) return;
  authBusy = true;
  const button = form.querySelector('button[type="submit"]'), error = $('#login-error');
  button.disabled = true; error.hidden = true;
  const panel = form.closest('.auth-panel');
  const register = form.id === 'register-form';
  try {
    if (register && $('#access-password').value !== $('#register-confirm').value) throw new Error('两次输入的密码不一致，请重新确认。');
    panel.classList.add('auth-working'); panel.setAttribute('aria-busy', 'true');
    panel.insertAdjacentHTML('beforeend', '<div id="login-progress" role="status" aria-live="polite"><div class="loading-bowl">' + icon('bowl') + '</div><h2>正在打开菜谱本</h2><p id="login-stage">正在验证账号，请稍候…</p><span class="loading-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>');
    loginTimer = setTimeout(() => { if ($('#login-stage')) $('#login-stage').textContent = '连接稍慢，仍在为你打开，请稍候…'; }, 6000);
    if (register) {
      if ($('#access-password').value !== $('#register-confirm').value) throw new Error('两次输入的密码不一致，请重新确认。');
      await db.register($('#register-name').value.trim(), $('#access-password').value, registrationId, emailForms.proof(form));
      page = 'account';
    } else await db.login($('#login-username').value.trim(), $('#access-password').value);
    if (editor && editor.userId !== db.user?.id) { saveDraftNow(); clearEditorMemory(); }
    resetBackup(); imageStop = true; imageData = null;
    permissionData = null; auditData = null; recoveryData = null; recoveryError = ''; auditQuery = ''; auditResult = ''; auditFrom = ''; auditTo = '';
    if (['permissions', 'logs', 'recovery', 'images', 'trash', 'drafts', 'sync', 'checkins'].includes(page)) page = 'my';
    channel?.postMessage({ type: 'account-changed', userId: db.user.id });
    clearTimeout(loginTimer); checkinGeneration++; checkinLoading = false; checkinReload = false; checkinData = null; checkinError = '';
    recipes = db.current(); recipeLoading = true; recipeLoadError = ''; render();
    $('#access-password').value = ''; $('#auth-root').innerHTML = '';
    $('#modal-root').inert = false; $('#app').inert = $('#modal-root').hasChildNodes();
    if (editor) toast('已重新登录，编辑内容还在，请再次保存。');
    else if (register) toast('注册成功，请在账号页复制并保存你的账号 ID。');
    else toast('已登录，欢迎回来。');
    refresh().catch(problem => { if (problem.status !== 401) toast(errorText(problem)); });
  } catch (problem) { error.textContent = errorText(problem); error.hidden = false; button.disabled = false; }
  finally { clearTimeout(loginTimer); authBusy = false; panel.classList.remove('auth-working'); panel.removeAttribute('aria-busy'); $('#login-progress')?.remove(); renderUpdateControls(); }
}

async function sendEmailCode(form) {
  if (authBusy || emailBusy) return;
  for (const name of ['email', 'username', 'currentPassword']) if (form.elements[name] && !form.elements[name].reportValidity()) return;
  const error = form.querySelector('.form-error');
  emailBusy = true; error.hidden = true;
  form.inert = true;
  try { await emailForms.send(form, db, db.user?.id); }
  catch (problem) { if (form.isConnected) { error.textContent = errorText(problem); error.hidden = false; } }
  finally { emailBusy = false; form.inert = false; }
}

function showBindEmail() {
  if (!db?.authenticated || emailBusy || db.user.emailVerifiedAt) return;
  emailMutationId = createId();
  showModal(`<div class="modal-header"><h2 id="modal-title" tabindex="-1">绑定找回邮箱</h2><button class="icon-button" data-action="close" aria-label="关闭邮箱绑定">${icon('close')}</button></div><div class="modal-scroll"><p class="page-lead">验证当前密码和邮箱后，可以通过邮箱找回密码。</p><form id="email-bind-form" data-email-purpose="bind"><label class="field"><span class="field-label">当前密码</span><input name="currentPassword" type="password" required maxlength="256" autocomplete="current-password"></label>${emailFields()}<p id="email-bind-error" class="form-error" role="alert" hidden></p><button type="submit" class="button primary">验证并绑定邮箱</button></form></div>`);
}

async function submitEmailForm(form) {
  if (authBusy || emailBusy || !form.reportValidity()) return;
  const bind = form.id === 'email-bind-form', values = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]'), error = form.querySelector('.form-error');
  error.hidden = true;
  if (!bind && values.newPassword !== values.confirmPassword) { error.textContent = '两次输入的新密码不一致。'; error.hidden = false; return; }
  let verification;
  try { verification = emailForms.proof(form); } catch (problem) { error.textContent = errorText(problem); error.hidden = false; return; }
  emailBusy = true; form.inert = true; button.disabled = true;
  const original = button.textContent; button.textContent = '正在验证…';
  try {
    const data = { ...values, ...verification, mutationId: emailMutationId };
    if (bind) {
      await db.bindEmail(data); form.reset(); emailBusy = false; await closeModal(); render(); toast('邮箱已绑定，可用于找回密码。');
    } else {
      const result = await db.recoverWithEmail(data); form.reset(); $('#auth-root').innerHTML = recoveryView.emailRequest(result.message); $('#auth-root [data-action="auth-login"]').focus();
    }
  } catch (problem) { if (form.isConnected) { error.textContent = errorText(problem); error.hidden = false; } }
  finally { emailBusy = false; form.inert = false; button.disabled = false; button.textContent = original; }
}

function accountPage() {
  const user = db?.user;
  if (!user) return '<h1 class="page-title">我的账号</h1><p class="page-lead">登录后查看账号信息。</p>';
  return `<h1 class="page-title">我的账号</h1><p class="page-lead">你好，${esc(user.displayName)}。<br>共享好味道，收藏自己的心头好。</p><section class="panel account-panel"><div class="panel-icon">${icon('people')}</div><h2>${esc(user.displayName)} <span class="role-badge">${roleName(user)}</span></h2><label class="field"><span class="field-label">账号 ID</span><input id="account-id" type="text" value="${esc(user.id)}" readonly spellcheck="false" aria-label="账号 ID"></label><button class="button ghost" data-action="copy-account">${icon('share')}复制账号 ID</button><p class="small-note">可用用户名或这个账号 ID 登录。如果旧用户名存在重名，请使用账号 ID 登录。${user.legacy ? '原账号 wupanfeng 仍可使用，请用当前密码登录。' : ''}</p><div class="account-rules"><p>${user.canEdit ? "当前拥有新增、编辑、删除、导入和恢复菜谱的权限。" : "当前仅有查看权限；编辑前请到账号授权页面申请。"}</p><p>你的 ${recipes.filter(recipe => recipe.favorite).length} 道收藏只属于这个账号，登录同一账号后可跨设备查看。</p></div><div class="management-actions"><button class="button ghost" data-action="navigate" data-page="permissions">账号授权</button><button class="button ghost" data-action="change-password">修改密码</button><button class="button ghost" data-action="logout">退出当前账号</button><button class="button ghost" data-action="logout-all">退出所有设备</button></div>${user.passwordChangedAt ? `<p class="small-note">最近修改密码：${esc(new Date(user.passwordChangedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))}</p>` : ""}</section><section class="panel account-email-panel"><h2>找回邮箱</h2>${user.emailVerifiedAt ? `<p class="account-email">${esc(user.email)}</p><p class="small-note">已验证。忘记密码时，可在登录页通过此邮箱重置。</p>` : `<p class="small-note">绑定邮箱后，即使忘记密码也能自行找回。管理员账号也建议绑定。</p><button class="button primary" data-action="bind-email">绑定找回邮箱</button>`}</section>`;
}

function recipePage() {
  const favoriteCount = recipes.filter(item => item.favorite).length;
  const categories = ['全部', ...new Set([...CATEGORIES.filter(item => recipes.some(recipe => recipe.category === item)), ...recipes.map(item => item.category)])];
  if (!categories.includes(category)) category = '全部';
  return `<section class="hero"><div class="hero-content"><p class="eyebrow">A LITTLE TASTE OF HOME</p><h1>把喜欢的味道，<br>留在自己的厨房。</h1><p class="hero-copy">记下一道拿手菜，也记下生活的滋味。<br>下次想吃时，就翻开这本小小的菜谱。</p><div class="stats"><span class="stat"><strong>${recipes.length}</strong>道菜谱</span><span class="stat"><strong id="favorite-count">${favoriteCount}</strong>道收藏</span><span class="stat"><strong>${new Set(recipes.map(item => item.category)).size}</strong>个分类</span></div></div><div class="hero-art">${heroArt}</div></section><section aria-label="菜谱列表"><div class="section-head"><div class="section-heading"><h2>${page === 'favorites' ? '我的收藏夹' : '共享菜谱'}</h2><span class="count" id="result-count">${recipes.length} 道</span></div>${db?.canEdit ? `<button class="button primary" data-action="new" ${recipeLoading ? 'disabled' : ''}>${icon("plus")}记一道新菜</button>` : `<button class="button ghost" data-action="navigate" data-page="permissions">申请编辑权限</button>`}</div><div class="toolbar"><label class="search-box">${icon('search')}<input id="search" type="search" enterkeyhint="search" autocomplete="off" placeholder="搜菜名、食材或心得…" aria-label="搜索菜谱" value="${esc(query)}"></label><select id="sort" class="sort-select" aria-label="菜谱排序"><option value="updated" ${sort === 'updated' ? 'selected' : ''}>最近更新</option><option value="name" ${sort === 'name' ? 'selected' : ''}>菜名排序</option></select></div><div class="chips" role="group" aria-label="按分类筛选">${categories.map(item => `<button class="chip ${item === category ? 'active' : ''}" aria-pressed="${item === category}" data-action="category" data-category="${esc(item)}">${esc(item)}</button>`).join('')}</div><div id="results"></div><aside class="tip-card"><span class="tip-icon">${icon('leaf')}</span><div><h3>好味道，藏在那些小心得里</h3><p>“出锅前再加一勺醋”“妈妈说要小火慢炖”——把这些也一起记下来。</p></div></aside></section>`;
}

function renderResults() {
  if (recipeLoading && !recipes.length) { $('#results').innerHTML = `<div class="recipe-loading" role="status"><span class="loading-ring" aria-hidden="true"></span><h3>${db?.authenticated ? '已登录，正在加载菜谱…' : '正在恢复登录…'}</h3><p id="recipe-load-stage">正在读取共享菜谱和照片，请稍候。</p></div>`; return; }
  if (recipeLoadError && !recipes.length) { $('#results').innerHTML = `<div class="recipe-loading" role="alert"><h3>菜谱暂时没有加载完成</h3><p>${esc(recipeLoadError)}</p><button class="button primary" data-action="sync">重新加载</button></div>`; return; }

  const result = filterRecipes(recipes, { query, category, favorites: page === 'favorites', sort });
  $('#result-count').textContent = `${result.length} 道`;
  $('#results').innerHTML = result.length ? `<div class="recipe-grid">${result.map(card).join('')}</div>` : emptyState();
}

function card(recipe) {
  return `<article class="recipe-card"><button class="card-open" data-action="detail" data-id="${esc(recipe.id)}" aria-label="查看 ${esc(recipe.title)}"><div class="card-photo">${recipe.photo ? `<img src="${esc(recipe.photo)}" alt="${esc(recipe.title)}" loading="lazy">` : `<div class="card-placeholder">${bowlArt}</div>`}<span class="card-category">${esc(recipe.category)}</span></div><div class="card-content"><h3>${esc(recipe.title)}</h3><p class="card-description">${esc(recipe.description || (recipe.ingredients.slice(0, 3).map(item => item.name).join(' · ')) || '留住这一道喜欢的味道')}</p><div class="card-meta"><span>${icon('clock')}${recipe.minutes ? `${recipe.minutes} 分钟` : '用时随心'}</span><span>${icon('people')}${recipe.servings} 人份</span></div></div></button><button class="favorite-button ${recipe.favorite ? 'selected' : ''}" data-action="favorite" data-id="${esc(recipe.id)}" aria-pressed="${recipe.favorite}" aria-label="${recipe.favorite ? '取消收藏' : '收藏'} ${esc(recipe.title)}">${icon('heart')}</button></article>`;
}

function emptyState() {
  if (!recipes.length && !db?.canEdit) return `<div class="empty-state"><div class="empty-art">${icon("book")}</div><h3>还没有共享菜谱</h3><p>管理员或获得编辑授权的账号添加菜谱后，便可在这里查看。</p><button class="button ghost" data-action="navigate" data-page="permissions">申请编辑权限</button></div>`;
  const isFirst = !recipes.length && !query && category === '全部' && page !== 'favorites';
  const isFavorites = page === 'favorites' && !recipes.some(item => item.favorite) && !query;
  return `<div class="empty-state"><div class="empty-art">${icon(isFavorites ? 'heart' : 'book')}</div><h3>${isFirst ? '第一道菜，想记点什么？' : isFavorites ? '给拿手菜，留一个特别的位置' : '还没找到这道菜'}</h3><p>${isFirst ? '一份家常做法，一道妈妈的拿手菜，<br>或是刚刚试成功的新味道。就从这里开始。' : isFavorites ? '点一下菜谱上的爱心，把常做、爱吃的菜放进收藏夹。' : '换个关键词，或试试其他分类。'}</p><div class="empty-actions">${isFirst ? `<button class="button primary" data-action="new" ${recipeLoading ? 'disabled' : ''}>${icon('plus')}记录我的第一道菜</button><button class="text-button" data-action="sample">先试试示例菜谱</button>` : `<button class="button secondary" data-action="reset-filters">${isFavorites ? '去看看我的菜谱' : '查看全部菜谱'}</button>`}</div></div>`;
}

function backupPage() {
  return `<h1 class="page-title">给好味道，留一份备份。</h1><p class="page-lead">请先完成后台同步，再导出一份备份，<br>把厨房记忆留在自己的“文件”里。</p><div class="backup-grid"><section class="panel">${backupExportPanel({ busy: backupBusy, error: backupError, prepared: preparedBackup?.userId === db?.user?.id ? preparedBackup : null, lastBackup, esc, icon })}</section><section class="panel"><div class="panel-icon orange">${icon('upload')}</div><h2>恢复一份备份</h2><p>支持峰味和旧版拾味的备份。确认后更新共享菜谱，相同菜谱保留较新版本。收藏只加入当前账号，保留现有收藏。</p>${db?.canEdit ? `<button class="button ghost" data-action="choose-import">${icon("upload")}选择备份文件</button><input id="import-file" type="file" accept=".json,application/json" hidden><p class="small-note">保留现有菜谱 · 每份最多 50 MiB、10000 道 · 分卷请逐份导入</p>${pendingImport ? importSummary() : ""}` : `<p class="permission-note">导入备份需要编辑权限。</p><button class="button ghost" data-action="navigate" data-page="permissions">申请编辑权限</button>`}</section></div>${fullBackupPanel({ user: db?.user, busy: fullBackupBusy, progress: fullBackupProgress, error: fullBackupError, prepared: fullBackupPrepared?.userId === db?.user?.id ? fullBackupPrepared : null, esc })}${legacyCount && db?.canEdit ? `<section class="panel migration-panel"><h2>迁移本机的旧菜谱</h2><p>检测到这个网址下原先保存的 ${legacyCount} 道菜谱。确认上传后，它们会保存在服务器；本机原数据仍保留。</p><button class="button primary" data-action="migrate">上传本机旧菜谱</button></section>` : ''}<section class="info-panel"><h2>共享菜谱，收藏分开。</h2><div class="info-row">${icon('lock')}<div><h3>菜谱共享，收藏独立</h3><p>登录后都能查看菜谱；新增、编辑、删除和导入需要管理员授权。收藏只属于当前账号，其他账号不会看到你的收藏状态。</p></div></div><div class="info-row">${icon('phone')}<div><h3>放到 iPhone 桌面，随手翻开</h3><p>Safari → 分享 → 添加到主屏幕。登录后从桌面图标使用。</p></div></div><div class="info-row">${icon('wifi')}<div><h3>${offlineReady ? '离线页面已准备好' : '离线查看'}</h3><p>已同步的菜谱可在离线时查看。新增、编辑、删除和导入需要联网，点击保存先写入本机，再后台上传；未完成任务在下次登录原账号后继续。退出登录会清除此设备的服务器缓存。</p></div></div><div class="info-row">${icon('backup')}<div><h3>历史版本与独立备份</h3><p>每次服务器保存都会保留历史版本，可在菜谱详情中恢复最近的版本。服务器存储额度用完时会明确提示失败；仍建议定期导出独立菜谱备份。普通菜谱备份不含账号与全部历史；管理员完整备份可用于全站迁移。</p></div></div></section>`;
}

function importSummary() {
  const plan = planImport(recipes, pendingImport);
  return `<div class="import-summary"><h3>已读到 ${pendingImport.length} 道菜谱</h3><p>新增 ${plan.added} 道 · 更新 ${plan.updated} 道 · 保留现有版本 ${plan.skipped} 道</p><div class="buttons"><button class="button primary" data-action="apply-import">确认导入</button><button class="button ghost" data-action="cancel-import">取消</button></div></div>`;
}

async function refresh() {
  const generation = ++refreshGeneration;
  recipeLoading = true; recipeLoadError = ''; render();
  try {
    const loaded = await db.all();
    if (generation !== refreshGeneration) return;
    recipes = loaded;
    // Optional local preferences must not delay the first usable recipe screen.
    const owner = db.user?.id;
    Promise.all([db.legacy().catch(() => []), db.setting('lastBackup')]).then(([legacy, backup]) => {
      if (generation !== refreshGeneration || owner !== db.user?.id) return;
      legacyCount = legacy.length; lastBackup = backup;
      if (page === 'backup') render();
    }).catch(() => {});
  } catch (error) { if (generation === refreshGeneration) { recipeLoadError = errorText(error); throw error; } }
  finally { if (generation === refreshGeneration) { recipeLoading = false; render(); } }
}
async function changed() { recipes = db.current(); render(); channel?.postMessage('changed'); }

function showModal(contents, layer = 'other', id = null) {
  if (modalLayer !== layer) modalParent = modalLayer === 'detail' && ['editor', 'history', 'cook', 'checkin'].includes(layer) ? { id: detailId || id, scroll: $('.modal-scroll')?.scrollTop || 0 } : null;
  modalLayer = layer; modalSequence++;
  if (!$('#modal-root').hasChildNodes()) restoreFocus = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${contents}</section></div>`;
  $('#app').inert = true;
  document.body.classList.add('locked');
  backNavigation.sync();
  requestAnimationFrame(() => {
    if (!$('#modal-root').inert) focusInitialField($('.modal input:not([type="file"]):not([type="hidden"]), .modal textarea'), $('#modal-title'));
  });
}

async function ask(title, message, action, danger = false) {
  if (confirmResolve) return false;
  const previousFocus = document.activeElement;
  $('#confirm-root').innerHTML = `<div class="modal-overlay confirm-overlay"><section class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">${esc(title)}</h2><p>${esc(message)}</p><div class="buttons"><button class="button ghost" data-confirm="cancel">取消</button><button class="button ${danger ? 'danger' : 'primary'}" data-confirm="accept">${esc(action)}</button></div></section></div>`;
  $('#modal-root').inert = true;
  $('[data-confirm="cancel"]').focus({ preventScroll: true });
  return new Promise(resolve => { confirmResolve = value => { $('#confirm-root').innerHTML = ''; $('#modal-root').inert = false; confirmResolve = null; previousFocus?.focus({ preventScroll: true }); resolve(value); }; });
}

async function closeModal() {
  if (passwordBusy || recoveryBusy || emailBusy || checkinBusy || editor?.saving || editor?.processingPhoto) return;
  if (checkinDraft && $('#checkin-form [name="note"]')?.value.trim() && !await ask('还没提交打卡', '关闭后，本次填写的心得会丢失。', '放弃打卡')) return;
  checkinDraft = null;
  passwordMutationId = null;
  recoveryDecision = null;
  const keptDraft = editor?.dirty;
  if (editor?.dirty) {
    if (!saveDraftNow()) { toast('草稿未能保存，请保持页面打开并复制内容。'); return; }
    if (!await ask('保留草稿并关闭？', '内容已保存在此设备，可在“我的 → 本机草稿”继续编辑。退出登录会清理本机草稿。', '保留并关闭')) return;
  }
  clearTimeout(draftTimer);
  await stopWakeLock();
  editor = null; detailId = null; cookStep = null; permissionDecision = null; modalLayer = null; modalParent = null; modalSequence++;
  $('#modal-root').innerHTML = ''; $('#app').inert = $('#auth-root').hasChildNodes(); document.body.classList.remove('locked');
  if (keptDraft) render();
  backNavigation.sync();
  (restoreFocus?.isConnected ? restoreFocus : $('[data-action="new"]'))?.focus({ preventScroll: true });
}

function showDetail(id) {
  const recipe = findRecipe(id); if (!recipe) return;
  detailId = id; editor = null; cookStep = null;
  showModal(`<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">菜谱里的好味道</h2><div class="header-label">我的私人菜谱</div></div><button class="icon-button" data-action="close" aria-label="关闭菜谱">${icon('close')}</button></div><div class="modal-scroll"><div class="detail-cover">${recipe.photo ? `<img src="${esc(recipe.photo)}" alt="${esc(recipe.title)}">` : `<div class="card-placeholder">${bowlArt}</div>`}</div><span class="detail-category">${esc(recipe.category)}</span><h3 class="detail-title">${esc(recipe.title)}</h3>${recipe.description ? `<p class="detail-description">${esc(recipe.description)}</p>` : ''}<div class="detail-meta"><span>${icon('clock')}${recipe.minutes ? `约 ${recipe.minutes} 分钟` : '用时随心'}</span><span>${icon('people')}${recipe.servings} 人份</span><span>${icon('book')}${recipe.steps.length} 个步骤</span></div><section class="detail-section"><h3>准备食材</h3>${recipe.ingredients.length ? `<ul class="ingredient-list">${recipe.ingredients.map(item => `<li><span class="ingredient-name">${esc(item.name)}</span><span class="ingredient-amount">${esc(item.amount || '适量')}</span></li>`).join('')}</ul>` : '<p class="no-content">还没有记录食材，可以在编辑里慢慢补上。</p>'}</section><section class="detail-section"><h3>开始下厨</h3>${recipe.steps.length ? `<ol class="detail-steps">${recipe.steps.map((text, index) => `<li><span class="step-number">${index + 1}</span><p>${esc(text)}</p></li>`).join('')}</ol>` : '<p class="no-content">做法还没写，可以先留住菜名，再补上步骤。</p>'}</section>${recipe.notes ? `<section class="detail-section"><h3>我的小心得</h3><div class="notes-block">${esc(recipe.notes)}</div></section>` : ''}<section class="detail-section checkin-invite"><div><h3>这道菜，今天做了吗？</h3><p>完成后打个卡，记下这次下厨的心得。</p></div><button class="button ghost" data-action="checkin" data-id="${esc(id)}">${icon('check')}制作完成，打卡</button></section><p class="detail-date">记于 ${date(recipe.createdAt)} · 最近更新 ${date(recipe.updatedAt)}</p><p id="detail-sync-status" class="small-note" role="status">${detailSyncStatus(id)}</p><button class="text-button" data-action="history" data-id="${esc(id)}">查看历史版本</button></div><div class="modal-footer"><div class="detail-actions"><button class="favorite-button ${recipe.favorite ? 'selected' : ''}" aria-pressed="${recipe.favorite}" data-action="favorite" data-id="${esc(id)}" aria-label="${recipe.favorite ? '取消收藏' : '收藏'}">${icon('heart')}</button>${db?.canEdit ? `<button class="button ghost" data-action="edit" data-id="${esc(id)}">${icon("edit")}编辑</button>` : `<button class="button ghost" data-action="navigate" data-page="permissions">申请编辑</button>`}</div><button class="button primary" data-action="cook" data-id="${esc(id)}" ${recipe.steps.length ? '' : 'disabled'}>跟着做${icon('arrow')}</button></div>`, 'detail', id);
}

function blankRecipe() {
  const now = new Date().toISOString();
  return { id: createId(), title: '', category: '家常菜', description: '', minutes: 0, servings: 2, favorite: false, photo: '', ingredients: [], steps: [], notes: '', createdAt: now, updatedAt: now };
}

function ingredientRow(item = { name: '', amount: '' }, index = 0) {
  return `<div class="ingredient-row"><input class="ingredient-name-input" aria-label="食材 ${index + 1} 名称" maxlength="100" placeholder="食材，如鸡蛋" value="${esc(item.name)}"><input class="ingredient-amount-input" aria-label="食材 ${index + 1} 用量" maxlength="100" placeholder="用量，如 2 个" value="${esc(item.amount)}"><button type="button" class="remove-row" data-action="remove-ingredient" aria-label="删除食材 ${index + 1}">${icon('close')}</button></div>`;
}

function stepRow(text = '', index = 0) {
  return `<div class="step-row"><span class="step-number">${index + 1}</span><textarea class="step-input" rows="3" maxlength="12000" aria-label="步骤 ${index + 1}" placeholder="记下这一步怎么做…">${esc(text)}</textarea><button type="button" class="remove-row" data-action="remove-step" aria-label="删除步骤 ${index + 1}">${icon('close')}</button></div>`;
}

function showEditor(id, draft = null) {
  if (!db?.canEdit) { toast("当前只有查看权限，请先申请编辑授权。"); return; }
  draft ||= id ? readDrafts().find(item => item.recipe.id === id) : null;
  const recipe = draft?.recipe || (id ? findRecipe(id) : blankRecipe()); if (!recipe) return;
  detailId = null; cookStep = null;
  editor = { recipe: structuredClone(recipe), baseRevision: draft ? draft.baseRevision : db.revision(recipe.id), isNew: draft ? draft.isNew : !id, userId: db.user.id, dirty: !!draft, saving: false, processingPhoto: false };
  showModal(`<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">${id ? '再添一点好味道' : '记一道新菜'}</h2><div class="header-label">先记下菜名，其他的可以慢慢补全。</div></div><button type="button" class="icon-button" data-action="close" aria-label="关闭编辑">${icon('close')}</button></div><div class="modal-scroll"><form id="recipe-form"><p id="form-error" class="form-error" role="alert" hidden></p><p id="draft-status" class="small-note" role="status">${draft ? "已恢复本机草稿，保存后才会同步到服务器。" : "填写内容会自动保存为本机草稿。"}</p><div class="photo-uploader" id="photo-uploader">${photoUploader()}</div><section class="form-section"><label class="field"><span class="field-label">菜名 <span aria-hidden="true">*</span></span><input id="recipe-title" name="title" required maxlength="80" placeholder="这道菜叫什么名字？" value="${esc(recipe.title)}"></label><label class="field"><span class="field-label">一句话介绍</span><input name="description" maxlength="300" placeholder="比如：十分钟就能做好的下饭菜" value="${esc(recipe.description)}"></label><div class="field-row"><label class="field"><span class="field-label">分类</span><input name="category" list="category-list" maxlength="30" placeholder="可自定义" value="${esc(recipe.category)}"><datalist id="category-list">${CATEGORIES.map(item => `<option value="${item}">`).join('')}</datalist></label><label class="field"><span class="field-label">用时 / 分钟</span><input name="minutes" type="number" inputmode="numeric" min="0" max="1440" step="1" placeholder="可不填" value="${recipe.minutes || ''}"></label><label class="field"><span class="field-label">份量 / 人份</span><input name="servings" type="number" inputmode="numeric" required min="1" max="100" step="1" value="${recipe.servings}"></label></div></section><section class="form-section"><div class="form-section-title"><h3>准备哪些食材</h3><span>食材与用量，分开记更清楚</span></div><div id="ingredient-rows">${(recipe.ingredients.length ? recipe.ingredients : [{ name: '', amount: '' }]).map(ingredientRow).join('')}</div><button type="button" class="add-row" data-action="add-ingredient">${icon('plus')}再加一种食材</button></section><section class="form-section"><div class="form-section-title"><h3>一步一步，怎么做</h3><span>一道菜，一点点写下来</span></div><div id="step-rows">${(recipe.steps.length ? recipe.steps : ['']).map(stepRow).join('')}</div><button type="button" class="add-row" data-action="add-step">${icon('plus')}再加一个步骤</button></section><section class="form-section"><label class="field"><span class="field-label">我的小心得</span><textarea name="notes" maxlength="12000" rows="3" placeholder="火候、调味、下次想改的地方…">${esc(recipe.notes)}</textarea></label></section></form></div><div class="modal-footer">${id ? `<button class="button danger" data-action="delete" data-id="${esc(id)}">${icon('trash')}删除</button>` : '<button class="button ghost" data-action="close">取消</button>'}<button id="save-recipe" class="button primary" type="submit" form="recipe-form">${icon('check')}保存这道菜</button></div>`, 'editor', id);
}

function photoUploader() {
  const photo = editor.recipe.photo;
  return `${photo ? `<img src="${esc(photo)}" alt="菜谱封面预览"><div class="photo-actions"><label for="photo-input" class="button ghost">更换照片</label><button type="button" class="button ghost" data-action="remove-photo">移除照片</button></div>` : `<label for="photo-input">${icon('photo')}<span>给这道菜留一张照片</span><small>从相册选择 · 也可以以后再加</small></label>`}<input type="file" id="photo-input" accept="image/*" hidden>${editor.photoInfo ? `<span class="photo-size-note" role="status">${esc(editor.photoInfo)}</span>` : ''}`;
}


function renumberRows() {
  document.querySelectorAll('.step-row').forEach((row, index) => {
    $('.step-number', row).textContent = index + 1;
    $('.step-input', row).setAttribute('aria-label', `步骤 ${index + 1}`);
    $('.remove-row', row).setAttribute('aria-label', `删除步骤 ${index + 1}`);
  });
  document.querySelectorAll('.ingredient-row').forEach((row, index) => {
    $('.ingredient-name-input', row).setAttribute('aria-label', `食材 ${index + 1} 名称`);
    $('.ingredient-amount-input', row).setAttribute('aria-label', `食材 ${index + 1} 用量`);
    $('.remove-row', row).setAttribute('aria-label', `删除食材 ${index + 1}`);
  });
}

async function saveRecipe() {
  if (!editor || editor.saving || editor.processingPhoto) return;
  const form = $('#recipe-form'); if (!form.reportValidity()) return;
  const button = $('#save-recipe'); const errorElement = $('#form-error');
  errorElement.hidden = true;
  try {
    const fields = new FormData(form);
    const ingredients = [...document.querySelectorAll('.ingredient-row')].map(row => ({ name: $('.ingredient-name-input', row).value.trim(), amount: $('.ingredient-amount-input', row).value.trim() }));
    if (ingredients.some(item => !item.name && item.amount)) throw new Error('请为已填写用量的食材补上名称');
    const recipe = validateRecipe({ ...editor.recipe, title: fields.get('title').trim(), description: fields.get('description').trim(), category: fields.get('category').trim() || '其他', minutes: Number(fields.get('minutes') || 0), servings: Number(fields.get('servings')), ingredients: ingredients.filter(item => item.name), steps: [...document.querySelectorAll('.step-input')].map(input => input.value.trim()).filter(Boolean), notes: fields.get('notes').trim(), updatedAt: new Date().toISOString() });
    saveDraftNow();
    editor.saving = true; form.inert = true; button.disabled = true; button.textContent = '正在保存…';
    await db.queuePut(recipe, { baseRevision: editor.baseRevision });
    removeDraft(editor.userId, recipe.id);
    editor.dirty = false; editor.saving = false;
    await changed(); await closeModal(); showDetail(recipe.id); toast('已保存到本机，正在后台同步');
    navigator.storage?.persist?.().catch(() => {});
  } catch (error) {
    if (editor) editor.saving = false;
    form.inert = false;
    button.disabled = false; button.innerHTML = `${icon('check')}保存这道菜`;
    errorElement.textContent = errorText(error); errorElement.hidden = false; errorElement.scrollIntoView({ block: 'center' });
  }
}

async function favorite(id) {
  const recipe = findRecipe(id); if (!recipe) return;
  await db.queueFavorite(id, !recipe.favorite);
  updateQueueView();
  toast(recipe.favorite ? '已取消收藏，后台同步中' : '已收藏，后台同步中');
}

async function deleteRecipe(id) {
  if (editor?.saving || editor?.processingPhoto) return;
  const recipe = findRecipe(id); if (!recipe) return;
  if (!await ask('删除这道菜？', `“${recipe.title}”会从共享菜谱本移除，所有账号都会看不到它。可在“我的 → 回收站”恢复，已有备份和历史版本保留。`, '删除菜谱', true)) return;
  await db.remove(id);
  removeDraft(db.user.id, id);
  if (editor) editor.dirty = false;
  await changed(); await closeModal(); toast('已移入回收站，可在“我的”中恢复');
}

async function startCook(id) {
  const recipe = findRecipe(id); if (!recipe?.steps.length) return;
  detailId = id; cookStep = 0; renderCook();
  if (navigator.wakeLock && document.visibilityState === 'visible') {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* Cooking still works without a screen lock. */ }
  }
}

function renderCook() {
  const recipe = findRecipe(detailId); if (!recipe) return;
  showModal(`<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">${esc(recipe.title)}</h2><div class="header-label">跟着做 · 一次专心一步</div></div><button class="icon-button" data-action="close" aria-label="退出跟着做">${icon('close')}</button></div><div class="modal-scroll"><div class="cook-progress" aria-hidden="true">${recipe.steps.map((_, index) => `<span class="${index <= cookStep ? 'done' : ''}"></span>`).join('')}</div><div class="cook-panel"><div class="cook-count">STEP ${String(cookStep + 1).padStart(2, '0')} / ${String(recipe.steps.length).padStart(2, '0')}</div><p class="cook-text">${esc(recipe.steps[cookStep])}</p></div><div class="cook-ingredients">本次食材：${esc(recipe.ingredients.map(item => `${item.name}${item.amount ? ` ${item.amount}` : ''}`).join(' · ') || '未记录食材')}</div></div><div class="modal-footer"><button class="button ghost" data-action="cook-back" ${cookStep === 0 ? 'disabled' : ''}>${icon('back')}上一步</button><button class="button primary" data-action="cook-next">${cookStep === recipe.steps.length - 1 ? '做好了' + icon('check') : '下一步' + icon('arrow')}</button></div>`, 'cook', detailId);
}

async function stopWakeLock() { if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; } }

async function exportBackup() {
  if (backupBusy) return;
  const generation = ++backupGeneration;
  backupBusy = true; backupError = ''; preparedBackup = null; render();
  try {
    const result = await prepareBackup(db);
    if (generation !== backupGeneration || result.userId !== db.user?.id) return;
    preparedBackup = result; recipes = db.current();
    toast(`已生成 ${result.files.length} 份最新备份，请下载保存。`);
  } catch (error) {
    if (generation === backupGeneration) backupError = `同步或校验未完成，未生成备份。${errorText(error)}`;
  } finally {
    if (generation === backupGeneration) { backupBusy = false; if (page === 'backup') render(); }
  }
}

async function saveBackupPart(index, share = false) {
  const prepared = preparedBackup, part = prepared?.files[index];
  if (!part || prepared.userId !== db.user?.id) { toast('请先同步并生成备份。'); return; }
  const file = part.file;
  if (share) {
    if (!navigator.canShare?.({ files: [file] })) { toast('此浏览器不支持分享文件，请使用下载备份'); return; }
    try { await navigator.share({ files: [file], title: '峰味菜谱备份' }); }
    catch (error) { if (error.name !== 'AbortError') toast('分享未完成，请使用下载备份'); return; }
  } else {
    const url = URL.createObjectURL(file), link = document.createElement('a');
    link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  if (preparedBackup !== prepared || prepared.userId !== db.user?.id) return;
  part.downloaded = true;
  if (prepared.files.every(item => item.downloaded)) {
    lastBackup = new Date().toISOString();
    await db.setSetting('lastBackup', lastBackup)?.catch(() => {});
  }
  if (preparedBackup !== prepared || prepared.userId !== db.user?.id) return;
  db.activity('backup.export').catch(() => {});
  if (preparedBackup === prepared && page === 'backup') render();
  toast('已发起保存，请确认备份文件已保存到设备。');
}

async function generateFullBackup(form) {
  if (fullBackupBusy) return;
  let password = form.elements.backupPassword.value;
  if (password !== form.elements.backupConfirm.value) { fullBackupError = '两次备份口令不一致'; render(); return; }
  const generation = ++fullBackupGeneration;
  form.reset(); fullBackupBusy = true; fullBackupPrepared = null; fullBackupError = ''; render();
  try {
    const result = await prepareFullBackup(db, password, progress => { if (generation === fullBackupGeneration) { fullBackupProgress = progress; if (page === 'backup') render(); } });
    if (generation === fullBackupGeneration) { fullBackupPrepared = result; fullBackupProgress = '已完成完整性校验和加密，请下载全部分卷。'; }
  } catch (error) { if (generation === fullBackupGeneration) { fullBackupError = errorText(error); fullBackupProgress = ''; } }
  finally { password = ''; if (generation === fullBackupGeneration) { fullBackupBusy = false; if (page === 'backup') render(); } }
}
function downloadFullBackup(index) {
  const prepared = fullBackupPrepared, part = prepared?.files[index];
  if (!part || db.user?.role !== 'admin' || prepared.userId !== db.user?.id) return;
  const url = URL.createObjectURL(part.file), link = document.createElement('a');
  link.href = url; link.download = part.file.name; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000); part.downloaded = true; render();
  toast('已发起保存，请保管好全部分卷和备份口令。');
}

async function loadBackup(file) {
  if (!db?.canEdit) throw new Error("导入备份需要编辑权限，请先申请授权。");
  if (!file) return;
  pendingImport = null;
  render();
  if (file.size > BACKUP_MAX_BYTES) throw new Error('单份备份超过 50 MiB，请选择分卷文件逐份导入');
  pendingImport = parseBackup(await file.text()); render();
  $('.import-summary')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function applyImport(button) {
  if (!db?.canEdit) throw new Error("导入备份需要编辑权限，请先申请授权。");
  if (!pendingImport) return;
  button.disabled = true; button.textContent = '正在导入…';
  try {
    const plan = planImport(await db.all(), pendingImport);
    for (let i = 0; i < plan.writes.length; i++) if (plan.writes[i].photo) {
      button.textContent = `正在优化导入图片 ${i + 1}/${plan.writes.length}…`;
      plan.writes[i] = { ...plan.writes[i], photo: (await optimizeDataPhoto(plan.writes[i].photo)).photo };
    }
    await db.import(plan.writes, { favorites: pendingImport }); pendingImport = null; await changed();
    toast(`导入完成：新增 ${plan.added} 道，更新 ${plan.updated} 道`);
  } catch (error) { button.disabled = false; button.textContent = '确认导入'; throw error; }
}

async function addSample() {
  const recipe = { ...blankRecipe(), title: '番茄炒蛋（示例）', description: '示例菜谱 · 一道简单的家常味道', category: '家常菜', minutes: 15, servings: 2, ingredients: [{ name: '番茄', amount: '2 个' }, { name: '鸡蛋', amount: '3 个' }, { name: '盐', amount: '适量' }, { name: '食用油', amount: '适量' }], steps: ['番茄洗净切块。鸡蛋打入碗中，加少许盐，搅拌均匀。', '热锅倒油，倒入蛋液，炒至凝固后盛出。', '锅里补少许油，放入番茄翻炒出汁，加入鸡蛋和盐，炒匀即可。'], notes: '这是用来体验功能的示例，可以编辑成自己的版本，也可以随时删除。' };
  await db.put(recipe); await changed(); showDetail(recipe.id); toast('示例已加入，可以编辑或删除');
}

async function showHistory(id) {
  const sequence = modalSequence, origin = page, owner = db.user?.id;
  const items = await db.history(id);
  if (sequence !== modalSequence || origin !== page || owner !== db.user?.id) return;
  historyItems = items; detailId = id;
  showModal(`<div class="modal-header"><h2 id="modal-title" tabindex="-1">最近的历史版本</h2><button class="icon-button" data-action="close" aria-label="关闭历史版本">${icon('close')}</button></div><div class="modal-scroll"><p class="small-note">恢复会生成一个新版本，原来的历史记录保留。最多展示最近 10 次保存。</p><div class="version-list">${historyItems.map((item, index) => `<article><h3>${esc(item.deleted ? '删除记录' : item.recipe.title)}</h3><p>${esc(new Date(item.savedAt).toLocaleString('zh-CN'))}${item.revision === db.revision(id) ? ' · 当前版本' : ''}</p>${item.recipe ? `<p>${esc(item.recipe.description || item.recipe.notes.slice(0, 80) || '已保留这次保存的食材、步骤和照片')}</p>${db?.canEdit ? `<button class="button ghost" data-action="restore-version" data-index="${index}" ${item.revision === db.revision(id) ? "disabled" : ""}>恢复这个版本</button>` : ""}` : ''}</article>`).join('')}</div></div>`, 'history', id);
}

async function restoreVersion(index) {
  const recipe = historyItems[index]?.recipe; if (!recipe) return;
  const baseRevision = db.revision(recipe.id);
  if (!await ask('恢复这个版本？', `“${recipe.title}”将成为服务器上的当前版本，其他历史内容仍然保留。`, '确认恢复')) return;
  await db.put(recipe, { baseRevision, operation: 'restore' }); await changed(); showDetail(recipe.id); toast('历史版本已恢复到服务器');
}

async function loadRecoveries() {
  if (db?.user?.role !== 'admin' || recoveryLoading) return;
  const adminId = db.user.id;
  recoveryError = ''; recoveryLoading = true;
  if (['my', 'recovery'].includes(page)) render();
  try {
    const data = await db.passwordRecoveries();
    if (db.user?.id === adminId && db.user?.role === 'admin') recoveryData = data;
  } catch (error) { if (db.user?.id === adminId) recoveryError = errorText(error); }
  finally { recoveryLoading = false; if (['my', 'recovery'].includes(page)) render(); }
}

function showRecoveryDecision(data) {
  if (db.user?.role !== 'admin' || recoveryBusy || !['reset', 'reject'].includes(data.kind)) return;
  const item = recoveryData?.requests.find(item => item.id === data.id && item.userId === data.user && item.status === 'pending');
  if (!item) return;
  recoveryDecision = { userId: item.userId, requestId: item.id, action: data.kind, mutationId: createId() };
  showModal(recoveryView.decision(item, data.kind));
}

async function submitRecoveryDecision(form) {
  if (recoveryBusy || !recoveryDecision || !form.reportValidity()) return;
  const values = Object.fromEntries(new FormData(form)), decision = { ...recoveryDecision };
  const button = form.querySelector('button[type="submit"]'), error = $('#recovery-decision-error');
  error.hidden = true;
  if (decision.action === 'reset' && values.newPassword !== values.confirmPassword) { error.textContent = '两次输入的新密码不一致。'; error.hidden = false; return; }
  recoveryBusy = true; form.inert = true; button.disabled = true; button.textContent = '正在处理…';
  try {
    const item = await db.decidePasswordRecovery({ ...decision, ...values, identityVerified: values.identityVerified === 'on' });
    if (recoveryData) recoveryData.requests = recoveryData.requests.map(request => request.id === item.id && request.userId === item.userId ? item : request);
    form.reset(); recoveryBusy = false; await closeModal(); render();
    if (decision.action === 'reset' && db.user?.role === 'admin') {
      showModal(recoveryView.completed(item, values.newPassword));
      if (item.userId === db.user.id) channel?.postMessage({ type: 'credentials-changed', userId: db.user.id });
    } else toast('已拒绝找回申请，账号密码保持原样。');
  } catch (problem) {
    if (problem.status === 401 || problem.code === 'ACCOUNT_CHANGED') { form.reset(); recoveryBusy = false; await closeModal(); }
    if (error.isConnected) { error.textContent = errorText(problem); error.hidden = false; }
  } finally {
    recoveryBusy = false; form.inert = false; button.disabled = false;
    button.textContent = decision.action === 'reset' ? '确认重置密码' : '确认拒绝申请';
  }
}

async function loadPermissions() {
  permissionData = null; permissionError = ''; render();
  try { permissionData = await db.permissions(); }
  catch (error) { permissionError = errorText(error); }
  if (page === 'permissions') render();
}

function showPermissionDecision(data) {
  if (db.user?.role !== 'admin') return;
  const account = permissionData?.accounts.find(item => item.id === data.user);
  if (!account) return;
  const titles = { approve: '批准编辑权限', reject: '拒绝编辑申请', revoke: '撤销编辑权限' };
  if (!titles[data.kind]) return;
  permissionDecision = { userId: account.id, requestId: data.id || null, action: data.kind, mutationId: createId() };
  showModal(`<div class="modal-header"><h2 id="modal-title" tabindex="-1">${titles[data.kind]}</h2><button class="icon-button" data-action="close" aria-label="关闭授权操作">${icon('close')}</button></div><div class="modal-scroll"><p class="page-lead">账号：${esc(account.displayName)}<br>${data.kind === 'approve' ? '获批后可新增、编辑、删除、导入和恢复菜谱。' : data.kind === 'revoke' ? '撤销后该账号只能查看菜谱，之后的写入请求会被拦截。' : '该账号保留查看权限，可以再次提交申请。'}</p><form id="permission-decision-form"><label class="field"><span class="field-label">管理员备注（选填）</span><textarea name="note" maxlength="500" rows="3" placeholder="可补充处理原因或使用要求"></textarea></label><p id="decision-error" class="form-error" role="alert" hidden></p><button type="submit" class="button ${data.kind === 'revoke' ? 'danger' : 'primary'}">确认${titles[data.kind]}</button></form></div>`);
}

async function submitPermissionRequest(form) {
  const button = form.querySelector('button[type="submit"]'), error = $('#permission-error');
  if (button.disabled || !form.reportValidity()) return;
  button.disabled = true; error.hidden = true;
  try {
    const data = await db.requestPermission(new FormData(form).get('reason').trim(), permissionRequestId);
    permissionRequestId = createId();
    permissionData = { ...permissionData, requests: [data.item, ...(permissionData?.requests || []).filter(item => item.id !== data.item.id)] };
    render(); toast('申请已提交，等待管理员审核。');
  } catch (problem) { error.textContent = errorText(problem); error.hidden = false; button.disabled = false; }
}

async function submitPermissionDecision(form) {
  const button = form.querySelector('button[type="submit"]'), error = $('#decision-error');
  if (button.disabled || !permissionDecision || !form.reportValidity()) return;
  button.disabled = true; error.hidden = true;
  try {
    const data = await db.decidePermission({ ...permissionDecision, note: new FormData(form).get('note').trim() });
    if (permissionData && data.requests) {
      permissionData.accounts = permissionData.accounts.map(account => account.id === data.account.id ? data.account : account);
      permissionData.requests = [...data.requests, ...permissionData.requests.filter(item => item.userId !== data.account.id)];
    }
    await closeModal(); render(); channel?.postMessage('changed'); toast('账号权限已更新。');
  } catch (problem) { error.textContent = errorText(problem); error.hidden = false; button.disabled = false; }
}

function showAccountDeletion(data) {
  if (db.user?.role !== 'admin') return;
  const selected = permissionData?.accounts.find(item => item.id === data.user);
  if (!selected || selected.role === 'admin') return;
  const normalize = value => value.normalize('NFKC').trim().toLowerCase();
  const accounts = data.scope === 'duplicates' ? permissionData.accounts.filter(item => item.role !== 'admin' && normalize(item.displayName) === normalize(selected.displayName)) : [selected];
  accountDeletion = { accounts: accounts.map(({ id, displayName }) => ({ id, displayName })), mutationId: createId() };
  showModal(`<div class="modal-header"><h2 id="modal-title" tabindex="-1">删除 ${accounts.length} 个账号</h2><button class="icon-button" data-action="close" aria-label="关闭删除账号">${icon('close')}</button></div><div class="modal-scroll"><p class="page-lead">下列账号将从账号列表移除，并停止登录和访问服务器。共享菜谱和历史操作日志会保留。</p><div class="management-list">${accounts.map(item => `<article class="request-card"><strong>${esc(item.displayName)}</strong><p class="small-note account-id">${esc(item.id)}</p>${item.createdAt ? `<p class="small-note">注册时间：${esc(new Date(item.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</p>` : ''}</article>`).join('')}</div><form id="account-delete-form"><p id="account-delete-error" class="form-error" role="alert" hidden></p><div class="management-actions"><button type="button" class="button ghost" data-action="close">取消</button><button type="submit" class="button danger">确认删除这 ${accounts.length} 个账号</button></div></form></div>`);
}

async function submitAccountDeletion(form) {
  const button = form.querySelector('button[type="submit"]'), error = $('#account-delete-error');
  if (button.disabled || !accountDeletion || db.user?.role !== 'admin') return;
  button.disabled = true; error.hidden = true;
  try {
    const result = await db.deleteAccounts(accountDeletion);
    accountDeletion = null; await closeModal(); await loadPermissions();
    toast(`已删除 ${result.deletedIds.length} 个账号。`);
  } catch (problem) { error.textContent = errorText(problem); error.hidden = false; button.disabled = false; }
}

async function loadLogs(more = false) {
  if (auditLoading) return;
  auditLoading = true; auditError = ''; if (!more) auditData = null; render();
  try {
    const expected = db.user?.id;
    let data;
    do {
      data = await db.audit({ cursor: more ? auditData?.cursor || '' : '', query: auditQuery, result: auditResult, from: auditFrom, to: auditTo });
      if (db.user?.id !== expected || page !== 'logs') return;
      if (data.indexing) { auditData = data; render(); }
    } while (data.indexing);
    auditData = more ? { ...data, items: [...auditData.items, ...data.items] } : data;
  } catch (error) { auditError = errorText(error); }
  finally { auditLoading = false; if (page === 'logs') render(); }
}

function showChangePassword() {
  if (!db?.authenticated || passwordBusy) return;
  passwordMutationId = createId();
  showModal(`<div class="modal-header"><h2 id="modal-title" tabindex="-1">修改密码</h2><button class="icon-button" data-action="close" aria-label="关闭修改密码">${icon('close')}</button></div><div class="modal-scroll"><p class="page-lead">账号：${esc(db.user.displayName)}<br>修改成功后，此设备保持登录，其他设备需要用新密码重新登录。</p><form id="password-change-form"><label class="field"><span class="field-label">当前密码</span><input name="currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label><label class="field"><span class="field-label">新密码</span><input name="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" placeholder="设置 8～128 个字符的新密码"></label><label class="field"><span class="field-label">确认新密码</span><input name="confirmPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" placeholder="再次输入新密码"></label><p id="password-change-error" class="form-error" role="alert" hidden></p><button type="submit" class="button primary">确认修改密码</button></form></div>`);
}

async function submitPasswordChange(form) {
  if (passwordBusy || !form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]'), error = $('#password-change-error');
  error.hidden = true;
  const values = Object.fromEntries(new FormData(form));
  if (values.newPassword !== values.confirmPassword) { error.textContent = '两次输入的新密码不一致，请重新确认。'; error.hidden = false; return; }
  passwordBusy = true; form.inert = true; button.disabled = true; button.textContent = '正在修改…';
  try {
    await db.changePassword({ ...values, mutationId: passwordMutationId });
    form.reset(); passwordBusy = false; await closeModal(); render();
    channel?.postMessage({ type: 'credentials-changed', userId: db.user.id });
    toast('密码已修改。此设备保持登录，其他设备请用新密码重新登录。');
  } catch (problem) {
    if (problem.status === 401) { form.reset(); passwordBusy = false; await closeModal(); }
    else if (form.isConnected) { error.textContent = errorText(problem); error.hidden = false; }
  } finally {
    passwordBusy = false; form.inert = false; button.disabled = false; button.textContent = '确认修改密码';
  }
}


async function loadImages() {
  if (imageBusy || db.user?.role !== 'admin') return;
  imageBusy = true; imageError = ''; imageData = null; imageProgress = '正在统计图片空间…'; render();
  const userId = db.user.id, items = []; let cursor = '';
  try {
    do {
      const result = await db.photoInventory(cursor);
      if (db.user?.id !== userId) return;
      items.push(...result.items); cursor = result.cursor;
      imageProgress = `正在统计图片 ${items.length}/${result.total}…`; if (page === 'images') render();
    } while (cursor);
    imageData = { items, bytes: items.reduce((sum, item) => sum + item.bytes, 0) };
  } catch (error) { imageError = errorText(error); }
  finally { imageBusy = false; imageProgress = ''; if (page === 'images') render(); }
}
async function optimizeImages() {
  if (imageBusy || db.user?.role !== 'admin' || !imageData) return;
  const pending = imageData.items.filter(item => !item.optimized);
  if (!pending.length) return;
  if (!await ask('优化已有图片', `将处理 ${pending.length} 张图片，替换为更小的版本并释放旧文件空间。当前菜谱和历史版本仍可显示图片，但原图画质无法从网站恢复。建议先保存独立备份。`, '开始优化')) return;
  imageBusy = true; imageStop = false; imageError = ''; imageSaved = 0; const userId = db.user.id;
  let done = 0;
  try {
    for (const item of pending) {
      if (imageStop || db.user?.id !== userId) break;
      imageProgress = `正在优化 ${done + 1}/${pending.length}，已释放 ${photoSize(imageSaved)}`; if (page === 'images') render();
      const original = await db.image(item.hash), result = await optimizeDataPhoto(original);
      if (imageStop || db.user?.id !== userId) break;
      const saved = await db.optimizeImage(item.hash, result.photo); imageSaved += saved.savedBytes || 0; done++;
    }
    imageProgress = `${imageStop ? '已停止' : '优化完成'}：处理 ${done} 张，释放 ${photoSize(imageSaved)}`;
    recipes = await db.all(); channel?.postMessage('changed');
  } catch (error) { imageError = `已完成 ${done} 张，释放 ${photoSize(imageSaved)}。${errorText(error)} 可刷新后继续。`; }
  finally {
    imageBusy = false;
    if (db.user?.id === userId) { const result = imageProgress, problem = imageError; await loadImages(); imageProgress = result; imageError ||= problem; if (page === 'images') render(); }
  }
}

async function cleanupImages() {
  if (imageBusy || db.user?.role !== 'admin' || !imageData) return;
  const hashes = imageData.items.filter(item => item.usage === 'orphan').map(item => item.hash), userId = db.user.id;
  if (!hashes.length || !await ask('清理无引用图片', `将核对并删除 ${hashes.length} 张完全无引用图片。当前菜谱、可恢复历史及回收站引用的照片都会保留。`, '开始清理', true)) return;
  if (userId !== db.user?.id) return;
  imageBusy = true; imageStop = false; imageError = '';
  try {
    for (let offset = 0; offset < hashes.length; offset += 100) {
      const value = { hashes: hashes.slice(offset, offset + 100), mutationId: createId() };
      let result;
      do {
        if (userId !== db.user?.id || imageStop) return;
        imageProgress = '正在核对所有菜谱、历史版本和回收站的图片引用…'; if (page === 'images') render();
        result = await db.cleanupImages(value);
      } while (!result.complete);
    }
    toast('清理完成，所有仍被引用的照片已保留。');
  } catch (error) { imageError = errorText(error); }
  finally {
    imageBusy = false;
    if (db.user?.id === userId) { const problem = imageError; await loadImages(); imageError ||= problem; if (page === 'images') render(); }
  }
}

async function exportAudit(format) {
  if (auditExportBusy || db.user?.role !== 'admin') return;
  auditExportBusy = true; render();
  try {
    const file = await db.exportAudit(format, { query: auditQuery, result: auditResult, from: auditFrom, to: auditTo });
    const url = URL.createObjectURL(file.blob), link = document.createElement('a');
    link.href = url; link.download = file.filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`已导出 ${file.count} 条操作日志。`);
  } catch (error) { toast(errorText(error)); }
  finally { auditExportBusy = false; if (page === 'logs') render(); }
}

async function handleAction(button) {
  const action = button.dataset.action, id = button.dataset.id;
  switch (action) {
    case 'check-update': await updater.check(true); break;
    case 'checkin': showCheckin(id); break;
    case 'checkin-back': await goBack(); break;
    case 'reload-checkins': await loadCheckins(); break;
    case 'more-checkins': await loadCheckins(true); break;
    case 'delete-checkin': await deleteCheckin(id); break;
    case 'auth-login': if (!authBusy && !emailBusy) showLogin(); break;
    case 'auth-register': if (!authBusy && !emailBusy) showLogin('验证邮箱后注册，可以查看共享菜谱，并拥有自己的收藏夹。', 'register'); break;
    case 'auth-recovery': if (!authBusy && !emailBusy) showRecoveryRequest(); break;
    case 'auth-manual-recovery': if (!authBusy && !emailBusy) showManualRecoveryRequest(); break;
    case 'send-email-code': await sendEmailCode(button.closest('form')); break;
    case 'bind-email': showBindEmail(); break;
    case 'reload-recovery': await loadRecoveries(); break;
    case 'recovery-decision': showRecoveryDecision(button.dataset); break;
    case 'generate-recovery-password': {
      const bytes = crypto.getRandomValues(new Uint8Array(20));
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const password = Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
      $('#recovery-decision-form [name="newPassword"]').value = password;
      $('#recovery-decision-form [name="confirmPassword"]').value = password;
      toast('随机密码已生成并填写，重置成功后可复制。'); break;
    }
    case 'copy-recovery-password': {
      const input = $('#recovery-result-password'); if (!input) break;
      try { await navigator.clipboard.writeText(input.value); toast('新密码已复制，请线下告知用户。'); }
      catch { input.focus(); input.select(); toast('新密码已选中，请使用复制菜单。'); } break;
    }
    case 'change-password': showChangePassword(); break;
    case 'export-audit': await exportAudit(button.dataset.format); break;
    case 'copy-account':
      try { await navigator.clipboard.writeText(db.user.id); toast('账号 ID 已复制，请保存好。'); }
      catch { $('#account-id').focus(); $('#account-id').select(); toast('账号 ID 已选中，请长按或使用复制菜单。'); }
      break;
    case 'sync': button.disabled = true; try { await refresh(); toast(db.readOnly ? '服务器暂不可达，正在查看缓存。' : '已读取服务器上的最新菜谱'); } finally { if (button.isConnected) button.disabled = false; } break;
    case 'logout':
    case 'logout-all': {
      const all = action === 'logout-all';
      if (all && !await ask('退出所有设备？', '当前设备也会退出，所有设备需要重新登录。', '全部退出')) break;
      if (readDrafts().length && !await ask('退出并清理本机草稿？', '此设备未提交的草稿和离线缓存将被清除。需要保留的内容请先保存到服务器。', '退出并清理', true)) break;
      const queued = db.syncJobs.length;
      if (queued && !await ask('仍有待同步修改，退出账号？', `${queued} 项后台任务会保留在此设备，重新登录当前账号后继续。同步完成前请勿清理网站数据。`, '退出账号')) break;
      const owner = db.user?.id;
      const cleared = await db.logout(all);
      let draftsCleared = true; try { draftStore?.clear(owner); } catch { draftsCleared = false; }
      clearEditorMemory(); resetBackup(); imageStop = true; imageData = null;
      permissionData = null; auditData = null; recoveryData = null; trashData = null; retentionData = null; recoveryError = ''; auditQuery = ''; auditResult = ''; auditFrom = ''; auditTo = '';
      recipes = []; pendingImport = null; historyItems = []; page = 'recipes'; legacyCount = 0;
      channel?.postMessage({ type: 'account-changed', userId: null }); render();
      showLogin(queued ? '已退出登录。后台任务保留在本机，请登录原账号继续同步。' : !cleared || !draftsCleared ? '已退出登录。部分本机数据未能清理，可在浏览器设置中清除此网站数据。' : db.pendingLogout ? '已退出并清除此设备数据。服务器会话将在网络可用时完成注销。' : all ? '已退出所有设备，请重新登录。' : '已退出登录，此设备缓存和草稿已清除。'); break;
    }
    case 'history': await showHistory(id); break;
    case 'restore-version': await restoreVersion(Number(button.dataset.index)); break;
    case 'migrate': pendingImport = await db.legacy(); render(); $('.import-summary')?.scrollIntoView({ block: 'center' }); break;
    case 'navigate': await navigate(button.dataset.page); break;
    case 'back': await backNavigation.back(); break;
    case 'reload-images': await loadImages(); break;
    case 'optimize-images': await optimizeImages(); break;
    case 'cleanup-images': await cleanupImages(); break;
    case 'stop-images': imageStop = true; imageProgress = '正在完成当前图片，随后停止…'; render(); break;
    case 'reload-permissions': await loadPermissions(); break;
    case 'permission-decision': showPermissionDecision(button.dataset); break;
    case 'account-delete': showAccountDeletion(button.dataset); break;
    case 'load-more-logs': await loadLogs(true); break;
    case 'new': showEditor(); break;
    case 'resume-draft': { const draft = readDrafts().find(item => item.recipe.id === id); if (draft) showEditor(draft.isNew ? undefined : id, draft); break; }
    case 'discard-draft': if (await ask('删除这份草稿？', '只删除此设备未提交的内容，服务器菜谱保持原样。', '删除草稿', true)) { removeDraft(db.user.id, id); render(); } break;
    case 'retry-sync': db.retrySync().catch(error => toast(errorText(error))); toast('正在重试后台同步'); break;
    case 'discard-sync': {
      if (await ask('放弃本机修改？', '将移除此菜谱尚未完成的本机任务并重新读取服务器版本。其他设备已保存的内容保持不变。', '放弃修改', true)) { await db.discardSync(button.dataset.token); await refresh(); }
      break;
    }
    case 'copy-sync': {
      const job = db.syncJobs.find(item => item.token === button.dataset.token); if (!job?.recipe) break;
      if (!await ask('另存为新菜？', '保留服务器上的原菜谱，将这份本机内容另存为一条新菜谱。', '另存为新菜')) break;
      const recipe = { ...job.recipe, id: createId(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await db.queuePut(recipe, { baseRevision: null }); await db.discardSync(job.token); await changed(); showDetail(recipe.id); break;
    }
    case 'purge-trash': button.disabled = true; try { await purgeTrash(id); } finally { button.disabled = false; } break;
    case 'reload-trash': await loadTrash(); break;
    case 'load-more-trash': await loadTrash(true); break;
    case 'restore-trash': button.disabled = true; try { await restoreTrash(id); } finally { button.disabled = false; } break;
    case 'reload-retention': await loadRetention(); break;
    case 'clean-audit': await cleanAudit(); break;
    case 'apply-update': await applyUpdate(); break;
    case 'detail': if (!findRecipe(id)) { toast('这道菜已移除，打卡记录仍保留。'); break; } showDetail(id); db.activity('recipe.view', id).catch(() => {}); break;
    case 'edit': showEditor(id); break;
    case 'close': await backNavigation.back(); break;
    case 'favorite': await favorite(id); break;
    case 'category': category = button.dataset.category; render(); break;
    case 'reset-filters': page = 'recipes'; query = ''; category = '全部'; render(); break;
    case 'sample': button.disabled = true; try { await addSample(); } finally { button.disabled = false; } break;
    case 'add-ingredient': if ($('#ingredient-rows').children.length >= 100) { toast('最多记录 100 种食材'); break; } $('#ingredient-rows').insertAdjacentHTML('beforeend', ingredientRow()); markDraftDirty(); renumberRows(); $('#ingredient-rows').lastElementChild.querySelector('input').focus(); break;
    case 'add-step': if ($('#step-rows').children.length >= 100) { toast('最多记录 100 个步骤'); break; } $('#step-rows').insertAdjacentHTML('beforeend', stepRow()); markDraftDirty(); renumberRows(); $('#step-rows').lastElementChild.querySelector('textarea').focus(); break;
    case 'remove-ingredient': button.closest('.ingredient-row').remove(); markDraftDirty(); renumberRows(); break;
    case 'remove-step': button.closest('.step-row').remove(); markDraftDirty(); renumberRows(); break;
    case 'remove-photo': if (editor.processingPhoto) break; editor.recipe.photo = ''; editor.photoInfo = ''; markDraftDirty(); $('#photo-uploader').innerHTML = photoUploader(); break;
    case 'delete': await deleteRecipe(id); break;
    case 'cook': await startCook(id); db.activity('recipe.cook', id).catch(() => {}); break;
    case 'cook-back': if (cookStep > 0) { cookStep--; renderCook(); } break;
    case 'cook-next': if (cookStep === findRecipe(detailId).steps.length - 1) { const currentId = detailId; await stopWakeLock(); showCheckin(currentId); } else { cookStep++; renderCook(); } break;
    case 'export': await exportBackup(); break;
    case 'download-full-backup': downloadFullBackup(Number(button.dataset.index)); break;
    case 'download-backup-part': await saveBackupPart(Number(button.dataset.index)); break;
    case 'share-backup-part': await saveBackupPart(Number(button.dataset.index), true); break;
    case 'choose-import': $('#import-file').click(); break;
    case 'apply-import': await applyImport(button); break;
    case 'cancel-import': pendingImport = null; render(); break;
  }
}

document.addEventListener('click', event => {
  const confirmButton = event.target.closest('[data-confirm]');
  if (confirmButton) { confirmResolve?.(confirmButton.dataset.confirm === 'accept'); return; }
  const button = event.target.closest('[data-action]');
  if (button && !button.disabled) handleAction(button).catch(error => toast(errorText(error)));
});
document.addEventListener('input', event => {
  const emailForm = event.target.closest('form[data-email-purpose]');
  if (emailForm) {
    emailForms.changed(emailForm, event.target);
    if (emailForm.id !== 'register-form') { emailMutationId = createId(); emailForm.querySelector('.form-error').hidden = true; }
  }
  if (event.target.id === 'search') { query = event.target.value; if (!event.isComposing) renderResults(); }
  else if (event.target.closest('#login-form, #register-form')) { $('#login-error').hidden = true; if (event.target.closest('#register-form')) registrationId = createId(); }
  else if (event.target.closest('#password-change-form')) { passwordMutationId = createId(); $('#password-change-error').hidden = true; }
  else if (event.target.closest('#checkin-form') && checkinDraft) { checkinDraft.mutationId = createId(); $('#checkin-error').hidden = true; }
  else if (editor && event.target.closest('#recipe-form')) markDraftDirty();
});
document.addEventListener('compositionend', event => {
  if (event.target.id === 'search') { query = event.target.value; renderResults(); }
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'sort') { sort = event.target.value; renderResults(); }
    if (event.target.id === 'import-file') await loadBackup(event.target.files[0]);
    if (event.target.id === 'photo-input' && editor && !editor.processingPhoto && event.target.files[0]) {
      const currentEditor = editor;
      currentEditor.processingPhoto = true; $('#save-recipe').disabled = true; toast('正在处理照片…');
      try {
        const result = await compressPhoto(event.target.files[0], toast);
        const photo = result.photo; currentEditor.photoInfo = `${result.type.split('/')[1].toUpperCase()} · ${result.width} × ${result.height} · ${photoSize(result.bytes)}`;
        if (editor === currentEditor) { editor.recipe.photo = photo; markDraftDirty(); $('#photo-uploader').innerHTML = photoUploader(); toast(`照片已优化：${photoSize(result.originalBytes)} → ${photoSize(result.bytes)}`); }
      } finally { currentEditor.processingPhoto = false; if (editor === currentEditor) $('#save-recipe').disabled = false; }
    }
  } catch (error) { toast(errorText(error)); }
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'checkin-form') { event.preventDefault(); submitCheckin(form); return; }
  if (['email-recovery-form', 'email-bind-form'].includes(form.id)) { event.preventDefault(); submitEmailForm(form); return; }
  if (form.id === 'password-recovery-form') { event.preventDefault(); submitRecoveryRequest(form); return; }
  if (form.id === 'recovery-decision-form') { event.preventDefault(); submitRecoveryDecision(form); return; }
  if (form.id === 'full-backup-form') { event.preventDefault(); generateFullBackup(form); return; }
  if (form.id === 'recipe-form') { event.preventDefault(); saveRecipe(); }
  else if (['login-form', 'register-form'].includes(form.id)) { event.preventDefault(); login(form); }
  else if (form.id === 'password-change-form') { event.preventDefault(); submitPasswordChange(form); }
  else if (form.id === 'permission-request-form') { event.preventDefault(); submitPermissionRequest(form); }
  else if (form.id === 'permission-decision-form') { event.preventDefault(); submitPermissionDecision(form); }
  else if (form.id === 'account-delete-form') { event.preventDefault(); submitAccountDeletion(form); }
  else if (form.id === 'audit-filter-form') {
    event.preventDefault(); const data = new FormData(form); auditQuery = data.get('query').trim(); auditResult = data.get('result'); auditFrom = data.get('from') || ''; auditTo = data.get('to') || ''; loadLogs();
  }
});
document.addEventListener('keydown', event => {
  // Enter confirms an IME candidate first; only a subsequent search action dismisses the keyboard.
  if (event.key === 'Enter' && event.target.id === 'search' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); event.target.blur(); return;
  }
  if (event.key === 'Escape' && $('#auth-root').hasChildNodes() && !confirmResolve) return;
  if (event.key === 'Escape') { if (confirmResolve) confirmResolve(false); else if ($('#modal-root').hasChildNodes()) backNavigation.back(); }
  if (event.key !== 'Tab') return;
  const root = $('#confirm-root').hasChildNodes() ? $('#confirm-root') : $('#auth-root').hasChildNodes() ? $('#auth-root') : $('#modal-root').hasChildNodes() ? $('#modal-root') : null;
  if (!root) return;
  const controls = [...root.querySelectorAll('button:not(:disabled), input:not([hidden]), textarea, select, [tabindex="0"]')].filter(element => element.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
window.addEventListener('pagehide', saveDraftNow);
window.addEventListener('beforeunload', event => { saveDraftNow(); if (editor?.dirty || imageBusy || backupBusy || fullBackupBusy) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('fengwei:queue-changed', updateQueueView);
window.addEventListener('fengwei:checkin-confirmed', event => {
  const detail = event.detail; if (detail.userId !== db?.user?.id) return;
  checkinRevision++;
  checkinData ||= { items: [], total: 0, dishes: null, cursor: null };
  if (checkinData) {
    const items = new Map(checkinData.items.map(item => [item.id, item]));
    if (detail.deleted) { if (items.delete(detail.id)) checkinData.total = Math.max(0, checkinData.total - 1); }
    else if (detail.item) { if (!items.has(detail.item.id)) checkinData.total++; items.set(detail.item.id, detail.item); }
    checkinData.items = [...items.values()].sort((a, b) => b.cookedAt.localeCompare(a.cookedAt));
  }
});
window.addEventListener('fengwei:checkins-changed', () => {
  channel?.postMessage({ type: 'checkins-changed', userId: db?.user?.id });
  if (page === 'checkins') loadCheckins();
});
window.addEventListener('fengwei:sync-complete', () => channel?.postMessage('changed'));
window.addEventListener('online', () => { db?.resumeSync().catch(() => {}); db?.completeLogout().catch(() => {}); toast('网络已连接，正在恢复后台同步。'); if (db && !editor && !$('#modal-root').hasChildNodes() && !$('#auth-root').hasChildNodes()) refresh().catch(error => toast(errorText(error))); });
window.addEventListener('offline', () => toast('已离线，已同步的菜谱仍可查看；修改需要联网保存。'));
window.addEventListener('fengwei:sync-progress', event => {
  const stage = $('#recipe-load-stage');
  if (stage) stage.textContent = event.detail.photos ? `正在加载 ${event.detail.photos} 张菜品照片…` : '正在整理菜谱，即将准备好。';
});
window.addEventListener('fengwei:permissions-changed', () => { permissionData = null; render(); });
window.addEventListener('fengwei:login-required', async () => {
  refreshGeneration++; recipeLoading = false; checkinGeneration++; checkinLoading = false; checkinReload = false; checkinData = null; checkinError = '';
  if (checkinDraft) { checkinDraft = null; checkinBusy = false; await closeModal(); }
  const recoveryForm = $('#recovery-decision-form');
  if (recoveryForm || $('#recovery-result-password')) { recoveryForm?.reset(); recoveryBusy = false; await closeModal(); }
  const passwordForm = $('#password-change-form');
  if (passwordForm) { passwordForm.reset(); passwordBusy = false; await closeModal(); }
  const emailForm = $('#email-bind-form');
  if (emailForm) { emailForm.reset(); emailBusy = false; await closeModal(); }
  resetBackup(); imageStop = true; imageData = null;
  permissionData = null; auditData = null; recoveryData = null; recoveryError = '';
  recipes = []; pendingImport = null; historyItems = []; render();
  showLogin(editor ? '登录已失效，请使用当前密码重新登录。正在编辑的内容会保留。' : '登录已失效，请使用当前密码重新登录。');
});
channel?.addEventListener('message', async event => {
  if (!db) return;
  try {
    if (event.data?.type === 'checkins-changed' && event.data.userId === db.user?.id) { checkinData = null; if (page === 'checkins') await loadCheckins(); return; }
    if (event.data?.type === 'credentials-changed' && event.data.userId === db.user?.id) {
      await db.refreshUser(); if (!editor && !$('#modal-root').hasChildNodes()) render();
      toast('密码已在另一个页面更新，此设备仍保持登录。'); return;
    }
    if (event.data?.type === 'account-changed' && event.data.userId !== db.user?.id) {
      const recoveryForm = $('#recovery-decision-form');
      if (recoveryForm || $('#recovery-result-password')) { recoveryForm?.reset(); recoveryBusy = false; await closeModal(); }
      const passwordForm = $('#password-change-form');
      if (passwordForm) { passwordForm.reset(); passwordBusy = false; await closeModal(); }
      const emailForm = $('#email-bind-form');
      if (emailForm) { emailForm.reset(); emailBusy = false; await closeModal(); }
      resetBackup(); imageStop = true; imageData = null;
      permissionData = null; auditData = null; recoveryData = null; recoveryError = '';
      if (event.data.userId) saveDraftNow(); else { try { draftStore?.clear(db.user?.id); } catch {} }
      clearEditorMemory(); trashData = null; retentionData = null;
      await db.forget(false); recipes = []; pendingImport = null; historyItems = []; render();
      if (!event.data.userId) { showLogin('账号已在其他页面退出，请重新登录。'); return; }
      await refresh();
      if (db.authenticated && !db.readOnly) {
        $('#auth-root').innerHTML = ''; $('#modal-root').inert = false; $('#app').inert = $('#modal-root').hasChildNodes();
      }
    } else if (!editor) {
      await refresh(); if (detailId && !findRecipe(detailId)) await closeModal();
    }
  } catch (error) { if (error.status !== 401) toast(errorText(error)); }
});
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') saveDraftNow();
  if (document.visibilityState === 'visible') { updater.check().catch(() => {}); db?.resumeSync().catch(() => {}); db?.completeLogout().catch(() => {}); }
  if (document.visibilityState === 'visible' && db?.authenticated && navigator.onLine !== false && !db.readOnly) {
    try { const role = db.user?.role; await db.refreshUser(); if (role !== db.user?.role) { render(); if (page === 'permissions') await loadPermissions(); toast(`账号权限已更新：${roleName(db.user)}`); } } catch {}
  }
  if (document.visibilityState === 'visible' && cookStep !== null && navigator.wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
});

setInterval(() => {
  if (document.visibilityState === 'visible' && navigator.onLine !== false && db?.user?.role === 'admin' && !db.readOnly && ['my', 'recovery'].includes(page) && !recoveryBusy && !$('#modal-root').hasChildNodes()) loadRecoveries();
}, 30000);

async function init() {
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    const secure = new URL(location.href); secure.protocol = 'https:'; location.replace(secure.href); return;
  }
  updater.start().then(async registration => { if (registration) { await navigator.serviceWorker.ready; offlineReady = true; if (page === 'backup') render(); } }).catch(() => {});
  // An installed offline shell remains ready even if registering/checking a
  // newer worker cannot reach the network on this launch.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistration('./').then(existing => { if (existing?.active) { offlineReady = true; if (page === 'backup') render(); } }).catch(() => {});
  updater.check().catch(() => {});
  try {
    window.dispatchEvent(new CustomEvent('fengwei:startup-phase', { detail: '正在读取本机菜谱…' }));
    db = await openStore();
    recipes = db.current(); recipeLoading = true; render();
    window.dispatchEvent(new Event('fengwei:ready'));
    refresh().catch(error => {
      if (error.status === 401) { if (!$('#auth-root').hasChildNodes()) showLogin(); }
      else toast(errorText(error));
    });
  } catch (error) {
    if (error.status === 401) showLogin();
    else {
      $('#app').innerHTML = `<div class="fatal"><span class="boot-mark">峰味</span><h1>菜谱本暂时打不开</h1><p>${esc(errorText(error))}</p><button class="button primary" id="retry">重新打开</button></div>`;
      $('#retry').addEventListener('click', () => location.reload());
    }
  }

}
init();
