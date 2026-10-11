import { CATEGORIES, createId, openStore, validateRecipe, filterRecipes, makeBackup, parseBackup, planImport, isPhoto } from './store.js';

const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
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
const bowlArt = `<svg viewBox="0 0 140 140" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><ellipse cx="70" cy="60" rx="47" ry="14"/><path d="M23 60c4 40 21 55 47 55s43-15 47-55M53 120h34M56 36c-12-13 12-14 0-27M72 34c-12-13 12-14 0-27"/><path d="M83 53c-2-20 10-31 28-29 3 17-8 30-28 29Zm1-1 16-16"/></g><ellipse cx="67" cy="63" rx="33" ry="7" fill="currentColor" opacity=".15"/></svg>`;
const heroArt = `<svg viewBox="0 0 360 270" aria-hidden="true"><ellipse cx="185" cy="240" rx="144" ry="13" fill="#e9ebdf"/><g transform="rotate(-9 171 149)"><rect x="78" y="45" width="178" height="194" rx="9" fill="#cdd8b4"/><rect x="89" y="42" width="161" height="187" rx="5" fill="#fffdf1" stroke="#dfe2ce"/><path d="M109 42v187" stroke="#dacdb9" stroke-width="1.3"/><path d="M132 77h94M132 95h55M132 170h87M132 188h76M132 205h88" stroke="#dce1cf" stroke-width="3" stroke-linecap="round"/><text x="132" y="148" fill="#647b56" font-family="serif" font-size="28">好好吃饭</text><g fill="none" stroke="#6f8260" stroke-width="3"><path d="M100 65c-22-11-22 10 0 9M100 104c-22-11-22 10 0 9M100 143c-22-11-22 10 0 9M100 182c-22-11-22 10 0 9"/></g></g><g transform="rotate(12 278 166)"><path d="M268 97h14v128l-7 16-7-16Z" fill="#c88b58"/><path d="M270 103h4v122" stroke="#eccca6" stroke-width="3"/><path d="m268 225 7 16 7-16" fill="#e7d4a7"/><path d="m272 235 3 6 3-6" fill="#4b5c43"/></g><g fill="#8f9f70"><path d="M281 81c-10-38 18-60 49-54-2 34-20 55-49 54Z"/><path d="M286 82c26-4 44 11 47 35-24 5-44-7-47-35Z"/></g><path d="m275 101 39-62M287 83l31 22" stroke="#526d49" stroke-width="2" fill="none"/><circle cx="65" cy="211" r="23" fill="#c9754c"/><path d="m53 192 12 5 9-7-4 11 10 6-13-1-7 8 1-12Z" fill="#6d8359"/><path d="M52 217c2 6 6 8 11 9" stroke="#dfaa83" stroke-width="3" stroke-linecap="round" fill="none"/><path d="m42 101 3 6 7 1-6 5 1 7-6-4-6 4 1-7-5-5 7-1Z" fill="#d2bb8e"/><path d="M302 196h12m-6-6v12" stroke="#b3ba91" stroke-width="2" stroke-linecap="round"/></svg>`;

let db, recipes = [], page = 'recipes', category = '全部', query = '', sort = 'updated';
let editor = null, detailId = null, cookStep = null, pendingImport = null, lastBackup = null;
let toastTimer, confirmResolve, restoreFocus, wakeLock = null, offlineReady = false;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('shiwei-changes') : null;
const date = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(value));
const errorText = error => error?.name === 'QuotaExceededError' ? '手机存储空间不足，未能保存。请释放空间后重试。' : error?.message || '操作未完成，请重试';
const findRecipe = id => recipes.find(item => item.id === id);

function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 3600);
}

function nav(mobile = false) {
  return `<nav class="${mobile ? 'mobile-nav' : 'desktop-nav'}" aria-label="${mobile ? '底部' : '主'}导航">${[['recipes', 'book', '菜谱本'], ['favorites', 'heart', '收藏夹'], ['backup', 'backup', '备份']].map(([id, mark, name]) => `<button class="nav-item ${page === id ? 'active' : ''}" data-action="navigate" data-page="${id}" ${page === id ? 'aria-current="page"' : ''}>${icon(mark)}<span>${name}</span></button>`).join('')}</nav>`;
}

function render() {
  $('#app').innerHTML = `<a class="skip-link" href="#main">跳到菜谱内容</a><div class="shell"><header class="header"><div class="brand"><div class="brand-icon">${icon('bowl')}</div><div><div class="brand-name">拾味</div><div class="brand-caption">我的私人菜谱本</div></div></div>${nav()}<span class="private-pill">${icon('lock')}仅保存在本机</span></header><main id="main">${page === 'backup' ? backupPage() : recipePage()}</main><footer class="footer"><span>一餐一饭，都是生活的小事。</span><span>${icon('leaf')}自己的菜谱，自己的味道</span></footer></div>${nav(true)}`;
  if (page !== 'backup') renderResults();
}

function recipePage() {
  const favoriteCount = recipes.filter(item => item.favorite).length;
  const categories = ['全部', ...new Set([...CATEGORIES.filter(item => recipes.some(recipe => recipe.category === item)), ...recipes.map(item => item.category)])];
  if (!categories.includes(category)) category = '全部';
  return `<section class="hero"><div class="hero-content"><p class="eyebrow">A LITTLE TASTE OF HOME</p><h1>把喜欢的味道，<br>留在自己的厨房。</h1><p class="hero-copy">记下一道拿手菜，也记下生活的滋味。<br>下次想吃时，就翻开这本小小的菜谱。</p><div class="stats"><span class="stat"><strong>${recipes.length}</strong>道菜谱</span><span class="stat"><strong>${favoriteCount}</strong>道收藏</span><span class="stat"><strong>${new Set(recipes.map(item => item.category)).size}</strong>个分类</span></div></div><div class="hero-art">${heroArt}</div></section><section aria-label="菜谱列表"><div class="section-head"><div class="section-heading"><h2>${page === 'favorites' ? '我的收藏夹' : '我的菜谱'}</h2><span class="count" id="result-count">${recipes.length} 道</span></div><button class="button primary" data-action="new">${icon('plus')}记一道新菜</button></div><div class="toolbar"><label class="search-box">${icon('search')}<input id="search" type="search" autocomplete="off" placeholder="搜菜名、食材或心得…" aria-label="搜索菜谱" value="${esc(query)}"></label><select id="sort" class="sort-select" aria-label="菜谱排序"><option value="updated" ${sort === 'updated' ? 'selected' : ''}>最近更新</option><option value="name" ${sort === 'name' ? 'selected' : ''}>菜名排序</option></select></div><div class="chips" role="group" aria-label="按分类筛选">${categories.map(item => `<button class="chip ${item === category ? 'active' : ''}" aria-pressed="${item === category}" data-action="category" data-category="${esc(item)}">${esc(item)}</button>`).join('')}</div><div id="results"></div><aside class="tip-card"><span class="tip-icon">${icon('leaf')}</span><div><h3>好味道，藏在那些小心得里</h3><p>“出锅前再加一勺醋”“妈妈说要小火慢炖”——把这些也一起记下来。</p></div></aside></section>`;
}

function renderResults() {
  const result = filterRecipes(recipes, { query, category, favorites: page === 'favorites', sort });
  $('#result-count').textContent = `${result.length} 道`;
  $('#results').innerHTML = result.length ? `<div class="recipe-grid">${result.map(card).join('')}</div>` : emptyState();
}

function card(recipe) {
  return `<article class="recipe-card"><button class="card-open" data-action="detail" data-id="${esc(recipe.id)}" aria-label="查看 ${esc(recipe.title)}"><div class="card-photo">${recipe.photo ? `<img src="${esc(recipe.photo)}" alt="${esc(recipe.title)}" loading="lazy">` : `<div class="card-placeholder">${bowlArt}</div>`}<span class="card-category">${esc(recipe.category)}</span></div><div class="card-content"><h3>${esc(recipe.title)}</h3><p class="card-description">${esc(recipe.description || (recipe.ingredients.slice(0, 3).map(item => item.name).join(' · ')) || '留住这一道喜欢的味道')}</p><div class="card-meta"><span>${icon('clock')}${recipe.minutes ? `${recipe.minutes} 分钟` : '用时随心'}</span><span>${icon('people')}${recipe.servings} 人份</span></div></div></button><button class="favorite-button ${recipe.favorite ? 'selected' : ''}" data-action="favorite" data-id="${esc(recipe.id)}" aria-pressed="${recipe.favorite}" aria-label="${recipe.favorite ? '取消收藏' : '收藏'} ${esc(recipe.title)}">${icon('heart')}</button></article>`;
}

function emptyState() {
  const isFirst = !recipes.length && !query && category === '全部' && page !== 'favorites';
  const isFavorites = page === 'favorites' && !recipes.some(item => item.favorite) && !query;
  return `<div class="empty-state"><div class="empty-art">${icon(isFavorites ? 'heart' : 'book')}</div><h3>${isFirst ? '第一道菜，想记点什么？' : isFavorites ? '给拿手菜，留一个特别的位置' : '还没找到这道菜'}</h3><p>${isFirst ? '一份家常做法，一道妈妈的拿手菜，<br>或是刚刚试成功的新味道。就从这里开始。' : isFavorites ? '点一下菜谱上的爱心，把常做、爱吃的菜放进收藏夹。' : '换个关键词，或试试其他分类。'}</p><div class="empty-actions">${isFirst ? `<button class="button primary" data-action="new">${icon('plus')}记录我的第一道菜</button><button class="text-button" data-action="sample">先试试示例菜谱</button>` : `<button class="button secondary" data-action="reset-filters">${isFavorites ? '去看看我的菜谱' : '查看全部菜谱'}</button>`}</div></div>`;
}

function backupPage() {
  const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';
  return `<h1 class="page-title">给好味道，留一份备份。</h1><p class="page-lead">菜谱和照片都保存在这台设备上。导出一份备份，<br>换手机时，也能带上你的厨房记忆。</p><div class="backup-grid"><section class="panel"><div class="panel-icon">${icon('download')}</div><h2>导出我的菜谱</h2><p>把全部 ${recipes.length} 道菜谱、照片和收藏状态，打包成一个备份文件。</p><button class="button primary" data-action="export">${icon('download')}下载备份</button>${canShare ? '<button class="text-button" data-action="share-backup">分享到“文件”</button>' : ''}<p class="small-note">${lastBackup ? `上次导出：${date(lastBackup)}` : '还没有导出过备份'} · JSON 格式，包含照片</p></section><section class="panel"><div class="panel-icon orange">${icon('upload')}</div><h2>恢复一份备份</h2><p>选择之前导出的文件。新增的菜谱会合并进来，相同菜谱保留较新的版本。</p><button class="button ghost" data-action="choose-import">${icon('upload')}选择备份文件</button><input id="import-file" type="file" accept=".json,application/json" hidden><p class="small-note">保留当前菜谱 · 单个文件最大 50 MB</p>${pendingImport ? importSummary() : ''}</section></div><section class="info-panel"><h2>这本菜谱，属于你。</h2><div class="info-row">${icon('lock')}<div><h3>菜谱只保存在当前设备</h3><p>照片和文字不会上传到服务器。不同手机、浏览器及桌面图标里的数据可能各自独立，不会自动同步。</p></div></div><div class="info-row">${icon('phone')}<div><h3>放到 iPhone 桌面，随手翻开</h3><p>用 Safari 打开正式网址 → 分享 → 添加到主屏幕；若有“作为网页 App 打开”选项，请开启。添加后，从桌面图标开始记录。</p></div></div><div class="info-row">${icon('wifi')}<div><h3>${offlineReady ? '离线页面已准备好' : '离线使用'}</h3><p>${offlineReady ? '首次完整打开并缓存后，即使没有网络，也能查看和编辑本机菜谱。' : '通过 HTTPS 正式网址完整打开一次后，会自动准备离线页面。局域网 HTTP 预览不支持离线安装。'}</p></div></div><div class="info-row">${icon('backup')}<div><h3>定期备份，让菜谱更安心</h3><p>清除网站数据、移除应用或设备存储不足时，本地数据可能丢失。建议把备份保存到“文件”或自己的 iCloud 云盘。</p></div></div></section>`;
}

function importSummary() {
  const plan = planImport(recipes, pendingImport);
  return `<div class="import-summary"><h3>已读到 ${pendingImport.length} 道菜谱</h3><p>新增 ${plan.added} 道 · 更新 ${plan.updated} 道 · 保留现有版本 ${plan.skipped} 道</p><div class="buttons"><button class="button primary" data-action="apply-import">确认导入</button><button class="button ghost" data-action="cancel-import">取消</button></div></div>`;
}

async function refresh() { recipes = await db.all(); render(); }
async function changed() { await refresh(); channel?.postMessage('changed'); }

function showModal(contents) {
  if (!$('#modal-root').hasChildNodes()) restoreFocus = document.activeElement;
  $('#modal-root').innerHTML = `<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${contents}</section></div>`;
  $('#app').inert = true;
  document.body.classList.add('locked');
  requestAnimationFrame(() => { ($('#recipe-title') || $('#modal-title'))?.focus({ preventScroll: true }); });
}

async function ask(title, message, action, danger = false) {
  if (confirmResolve) return false;
  const previousFocus = document.activeElement;
  $('#confirm-root').innerHTML = `<div class="modal-overlay confirm-overlay"><section class="confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title"><h2 id="confirm-title">${esc(title)}</h2><p>${esc(message)}</p><div class="buttons"><button class="button ghost" data-confirm="cancel">取消</button><button class="button ${danger ? 'danger' : 'primary'}" data-confirm="accept">${esc(action)}</button></div></section></div>`;
  $('#modal-root').inert = true;
  $('[data-confirm="cancel"]').focus();
  return new Promise(resolve => { confirmResolve = value => { $('#confirm-root').innerHTML = ''; $('#modal-root').inert = false; confirmResolve = null; previousFocus?.focus(); resolve(value); }; });
}

async function closeModal() {
  if (editor?.saving || editor?.processingPhoto) return;
  if (editor?.dirty && !await ask('还没保存这道菜', '关闭后，本次填写的内容会丢失。', '放弃修改')) return;
  await stopWakeLock();
  editor = null; detailId = null; cookStep = null;
  $('#modal-root').innerHTML = ''; $('#app').inert = false; document.body.classList.remove('locked');
  (restoreFocus?.isConnected ? restoreFocus : $('[data-action="new"]'))?.focus();
}

function showDetail(id) {
  const recipe = findRecipe(id); if (!recipe) return;
  detailId = id; editor = null; cookStep = null;
  showModal(`<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">菜谱里的好味道</h2><div class="header-label">我的私人菜谱</div></div><button class="icon-button" data-action="close" aria-label="关闭菜谱">${icon('close')}</button></div><div class="modal-scroll"><div class="detail-cover">${recipe.photo ? `<img src="${esc(recipe.photo)}" alt="${esc(recipe.title)}">` : `<div class="card-placeholder">${bowlArt}</div>`}</div><span class="detail-category">${esc(recipe.category)}</span><h3 class="detail-title">${esc(recipe.title)}</h3>${recipe.description ? `<p class="detail-description">${esc(recipe.description)}</p>` : ''}<div class="detail-meta"><span>${icon('clock')}${recipe.minutes ? `约 ${recipe.minutes} 分钟` : '用时随心'}</span><span>${icon('people')}${recipe.servings} 人份</span><span>${icon('book')}${recipe.steps.length} 个步骤</span></div><section class="detail-section"><h3>准备食材</h3>${recipe.ingredients.length ? `<ul class="ingredient-list">${recipe.ingredients.map(item => `<li><span class="ingredient-name">${esc(item.name)}</span><span class="ingredient-amount">${esc(item.amount || '适量')}</span></li>`).join('')}</ul>` : '<p class="no-content">还没有记录食材，可以在编辑里慢慢补上。</p>'}</section><section class="detail-section"><h3>开始下厨</h3>${recipe.steps.length ? `<ol class="detail-steps">${recipe.steps.map((text, index) => `<li><span class="step-number">${index + 1}</span><p>${esc(text)}</p></li>`).join('')}</ol>` : '<p class="no-content">做法还没写，可以先留住菜名，再补上步骤。</p>'}</section>${recipe.notes ? `<section class="detail-section"><h3>我的小心得</h3><div class="notes-block">${esc(recipe.notes)}</div></section>` : ''}<p class="detail-date">记于 ${date(recipe.createdAt)} · 最近更新 ${date(recipe.updatedAt)}</p></div><div class="modal-footer"><div class="detail-actions"><button class="favorite-button ${recipe.favorite ? 'selected' : ''}" aria-pressed="${recipe.favorite}" data-action="favorite" data-id="${esc(id)}" aria-label="${recipe.favorite ? '取消收藏' : '收藏'}">${icon('heart')}</button><button class="button ghost" data-action="edit" data-id="${esc(id)}">${icon('edit')}编辑</button></div><button class="button primary" data-action="cook" data-id="${esc(id)}" ${recipe.steps.length ? '' : 'disabled'}>跟着做${icon('arrow')}</button></div>`);
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

function showEditor(id) {
  const recipe = id ? findRecipe(id) : blankRecipe(); if (!recipe) return;
  detailId = null; cookStep = null;
  editor = { recipe: structuredClone(recipe), isNew: !id, dirty: false, saving: false, processingPhoto: false };
  showModal(`<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">${id ? '再添一点好味道' : '记一道新菜'}</h2><div class="header-label">先记下菜名，其他的可以慢慢补全。</div></div><button type="button" class="icon-button" data-action="close" aria-label="关闭编辑">${icon('close')}</button></div><div class="modal-scroll"><form id="recipe-form"><p id="form-error" class="form-error" role="alert" hidden></p><div class="photo-uploader" id="photo-uploader">${photoUploader()}</div><section class="form-section"><label class="field"><span class="field-label">菜名 <span aria-hidden="true">*</span></span><input id="recipe-title" name="title" required maxlength="80" placeholder="这道菜叫什么名字？" value="${esc(recipe.title)}"></label><label class="field"><span class="field-label">一句话介绍</span><input name="description" maxlength="300" placeholder="比如：十分钟就能做好的下饭菜" value="${esc(recipe.description)}"></label><div class="field-row"><label class="field"><span class="field-label">分类</span><input name="category" list="category-list" maxlength="30" placeholder="可自定义" value="${esc(recipe.category)}"><datalist id="category-list">${CATEGORIES.map(item => `<option value="${item}">`).join('')}</datalist></label><label class="field"><span class="field-label">用时 / 分钟</span><input name="minutes" type="number" inputmode="numeric" min="0" max="1440" step="1" placeholder="可不填" value="${recipe.minutes || ''}"></label><label class="field"><span class="field-label">份量 / 人份</span><input name="servings" type="number" inputmode="numeric" required min="1" max="100" step="1" value="${recipe.servings}"></label></div></section><section class="form-section"><div class="form-section-title"><h3>准备哪些食材</h3><span>食材与用量，分开记更清楚</span></div><div id="ingredient-rows">${(recipe.ingredients.length ? recipe.ingredients : [{ name: '', amount: '' }]).map(ingredientRow).join('')}</div><button type="button" class="add-row" data-action="add-ingredient">${icon('plus')}再加一种食材</button></section><section class="form-section"><div class="form-section-title"><h3>一步一步，怎么做</h3><span>一道菜，一点点写下来</span></div><div id="step-rows">${(recipe.steps.length ? recipe.steps : ['']).map(stepRow).join('')}</div><button type="button" class="add-row" data-action="add-step">${icon('plus')}再加一个步骤</button></section><section class="form-section"><label class="field"><span class="field-label">我的小心得</span><textarea name="notes" maxlength="12000" rows="3" placeholder="火候、调味、下次想改的地方…">${esc(recipe.notes)}</textarea></label></section></form></div><div class="modal-footer">${id ? `<button class="button danger" data-action="delete" data-id="${esc(id)}">${icon('trash')}删除</button>` : '<button class="button ghost" data-action="close">取消</button>'}<button id="save-recipe" class="button primary" type="submit" form="recipe-form">${icon('check')}保存这道菜</button></div>`);
}

function photoUploader() {
  const photo = editor.recipe.photo;
  return `${photo ? `<img src="${esc(photo)}" alt="菜谱封面预览"><div class="photo-actions"><label for="photo-input" class="button ghost">更换照片</label><button type="button" class="button ghost" data-action="remove-photo">移除照片</button></div>` : `<label for="photo-input">${icon('photo')}<span>给这道菜留一张照片</span><small>从相册选择 · 也可以以后再加</small></label>`}<input type="file" id="photo-input" accept="image/*" hidden>`;
}

async function compressPhoto(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('照片超过 20 MB，请选择较小的照片');
  if (!file.type.startsWith('image/')) throw new Error('请选择一张照片');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('这张照片暂时无法读取，请改用 JPEG 或 PNG 格式')); });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('照片尺寸不正确');
    const ratio = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d'); if (!context) throw new Error('照片处理未完成，请重试');
    context.fillStyle = '#fffefb'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL('image/jpeg', .82);
    if (!isPhoto(photo)) throw new Error('照片处理后仍然过大，请选择较小的照片');
    return photo;
  } finally { URL.revokeObjectURL(url); }
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
    editor.saving = true; form.inert = true; button.disabled = true; button.textContent = '正在保存…';
    await db.put(recipe);
    editor.dirty = false; editor.saving = false;
    await changed(); await closeModal(); showDetail(recipe.id); toast('这道好味道，记下了');
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
  await db.put({ ...recipe, favorite: !recipe.favorite, updatedAt: new Date().toISOString() });
  await changed();
  if (detailId === id) showDetail(id);
  toast(recipe.favorite ? '已移出收藏夹' : '已收进收藏夹');
}

async function deleteRecipe(id) {
  if (editor?.saving || editor?.processingPhoto) return;
  const recipe = findRecipe(id); if (!recipe) return;
  if (!await ask('删除这道菜？', `“${recipe.title}”会从当前设备移除，已有备份文件不受影响。`, '删除菜谱', true)) return;
  await db.remove(id);
  if (editor) editor.dirty = false;
  await changed(); await closeModal(); toast('菜谱已删除');
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
  showModal(`<div class="modal-header"><div><h2 id="modal-title" tabindex="-1">${esc(recipe.title)}</h2><div class="header-label">跟着做 · 一次专心一步</div></div><button class="icon-button" data-action="close" aria-label="退出跟着做">${icon('close')}</button></div><div class="modal-scroll"><div class="cook-progress" aria-hidden="true">${recipe.steps.map((_, index) => `<span class="${index <= cookStep ? 'done' : ''}"></span>`).join('')}</div><div class="cook-panel"><div class="cook-count">STEP ${String(cookStep + 1).padStart(2, '0')} / ${String(recipe.steps.length).padStart(2, '0')}</div><p class="cook-text">${esc(recipe.steps[cookStep])}</p></div><div class="cook-ingredients">本次食材：${esc(recipe.ingredients.map(item => `${item.name}${item.amount ? ` ${item.amount}` : ''}`).join(' · ') || '未记录食材')}</div></div><div class="modal-footer"><button class="button ghost" data-action="cook-back" ${cookStep === 0 ? 'disabled' : ''}>${icon('back')}上一步</button><button class="button primary" data-action="cook-next">${cookStep === recipe.steps.length - 1 ? '做好了' + icon('check') : '下一步' + icon('arrow')}</button></div>`);
}

async function stopWakeLock() { if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; } }

function backupFile() {
  const stamp = new Date();
  const name = `拾味菜谱备份-${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}.json`;
  return new File([makeBackup(recipes)], name, { type: 'application/json' });
}

async function exportBackup(share = false) {
  const file = backupFile();
  if (share) {
    if (!navigator.canShare?.({ files: [file] })) { toast('此浏览器不支持分享文件，请使用下载备份'); return; }
    try { await navigator.share({ files: [file], title: '拾味菜谱备份' }); }
    catch (error) { if (error.name !== 'AbortError') toast('分享未完成，请使用下载备份'); return; }
  } else {
    const url = URL.createObjectURL(file); const link = document.createElement('a');
    link.href = url; link.download = file.name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  lastBackup = new Date().toISOString(); await db.setSetting('lastBackup', lastBackup); render(); toast('备份已生成，请保存好这个文件');
}

async function loadBackup(file) {
  if (!file) return;
  pendingImport = null;
  render();
  if (file.size > 50 * 1024 * 1024) throw new Error('备份超过 50 MB，请选择较小的备份文件');
  pendingImport = parseBackup(await file.text()); render();
  $('.import-summary')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function applyImport(button) {
  if (!pendingImport) return;
  button.disabled = true; button.textContent = '正在导入…';
  try {
    const plan = planImport(await db.all(), pendingImport);
    await db.import(plan.writes); pendingImport = null; await changed();
    toast(`导入完成：新增 ${plan.added} 道，更新 ${plan.updated} 道`);
  } catch (error) { button.disabled = false; button.textContent = '确认导入'; throw error; }
}

async function addSample() {
  const recipe = { ...blankRecipe(), title: '番茄炒蛋（示例）', description: '示例菜谱 · 一道简单的家常味道', category: '家常菜', minutes: 15, servings: 2, ingredients: [{ name: '番茄', amount: '2 个' }, { name: '鸡蛋', amount: '3 个' }, { name: '盐', amount: '适量' }, { name: '食用油', amount: '适量' }], steps: ['番茄洗净切块。鸡蛋打入碗中，加少许盐，搅拌均匀。', '热锅倒油，倒入蛋液，炒至凝固后盛出。', '锅里补少许油，放入番茄翻炒出汁，加入鸡蛋和盐，炒匀即可。'], notes: '这是用来体验功能的示例，可以编辑成自己的版本，也可以随时删除。' };
  await db.put(recipe); await changed(); showDetail(recipe.id); toast('示例已加入，可以编辑或删除');
}

async function handleAction(button) {
  const action = button.dataset.action, id = button.dataset.id;
  switch (action) {
    case 'navigate': page = button.dataset.page; query = ''; category = '全部'; pendingImport = null; render(); window.scrollTo(0, 0); break;
    case 'new': showEditor(); break;
    case 'detail': showDetail(id); break;
    case 'edit': showEditor(id); break;
    case 'close': await closeModal(); break;
    case 'favorite': button.disabled = true; try { await favorite(id); } finally { button.disabled = false; } break;
    case 'category': category = button.dataset.category; render(); break;
    case 'reset-filters': page = 'recipes'; query = ''; category = '全部'; render(); break;
    case 'sample': button.disabled = true; try { await addSample(); } finally { button.disabled = false; } break;
    case 'add-ingredient': if ($('#ingredient-rows').children.length >= 100) { toast('最多记录 100 种食材'); break; } $('#ingredient-rows').insertAdjacentHTML('beforeend', ingredientRow()); editor.dirty = true; renumberRows(); $('#ingredient-rows').lastElementChild.querySelector('input').focus(); break;
    case 'add-step': if ($('#step-rows').children.length >= 100) { toast('最多记录 100 个步骤'); break; } $('#step-rows').insertAdjacentHTML('beforeend', stepRow()); editor.dirty = true; renumberRows(); $('#step-rows').lastElementChild.querySelector('textarea').focus(); break;
    case 'remove-ingredient': button.closest('.ingredient-row').remove(); editor.dirty = true; renumberRows(); break;
    case 'remove-step': button.closest('.step-row').remove(); editor.dirty = true; renumberRows(); break;
    case 'remove-photo': if (editor.processingPhoto) break; editor.recipe.photo = ''; editor.dirty = true; $('#photo-uploader').innerHTML = photoUploader(); break;
    case 'delete': await deleteRecipe(id); break;
    case 'cook': await startCook(id); break;
    case 'cook-back': if (cookStep > 0) { cookStep--; renderCook(); } break;
    case 'cook-next': if (cookStep === findRecipe(detailId).steps.length - 1) { const currentId = detailId; await stopWakeLock(); showDetail(currentId); toast('做好了，好好吃饭'); } else { cookStep++; renderCook(); } break;
    case 'export': await exportBackup(); break;
    case 'share-backup': await exportBackup(true); break;
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
  if (event.target.id === 'search') { query = event.target.value; renderResults(); }
  else if (editor && event.target.closest('#recipe-form')) editor.dirty = true;
});
document.addEventListener('change', async event => {
  try {
    if (event.target.id === 'sort') { sort = event.target.value; renderResults(); }
    if (event.target.id === 'import-file') await loadBackup(event.target.files[0]);
    if (event.target.id === 'photo-input' && editor && !editor.processingPhoto && event.target.files[0]) {
      const currentEditor = editor;
      currentEditor.processingPhoto = true; $('#save-recipe').disabled = true; toast('正在处理照片…');
      try {
        const photo = await compressPhoto(event.target.files[0]);
        if (editor === currentEditor) { editor.recipe.photo = photo; editor.dirty = true; $('#photo-uploader').innerHTML = photoUploader(); toast('照片已准备好，保存菜谱后一起留存'); }
      } finally { currentEditor.processingPhoto = false; if (editor === currentEditor) $('#save-recipe').disabled = false; }
    }
  } catch (error) { toast(errorText(error)); }
});
document.addEventListener('submit', event => { if (event.target.id === 'recipe-form') { event.preventDefault(); saveRecipe(); } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { if (confirmResolve) confirmResolve(false); else if ($('#modal-root').hasChildNodes()) closeModal(); }
  if (event.key !== 'Tab') return;
  const root = $('#confirm-root').hasChildNodes() ? $('#confirm-root') : $('#modal-root').hasChildNodes() ? $('#modal-root') : null;
  if (!root) return;
  const controls = [...root.querySelectorAll('button:not(:disabled), input:not([hidden]), textarea, select, [tabindex="0"]')].filter(element => element.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
window.addEventListener('beforeunload', event => { if (editor?.dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', () => toast('网络已连接'));
window.addEventListener('offline', () => toast(offlineReady ? '已离线，菜谱仍然可以使用' : '已离线，本机菜谱仍可编辑'));
channel?.addEventListener('message', async () => { if (db && !editor) { await refresh(); if (detailId && !findRecipe(detailId)) await closeModal(); } });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && cookStep !== null && navigator.wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
});

async function init() {
  try {
    db = await openStore(); recipes = await db.all(); lastBackup = await db.setting('lastBackup'); render();
  } catch (error) {
    $('#app').innerHTML = `<div class="fatal"><span class="boot-mark">拾味</span><h1>菜谱本暂时打不开</h1><p>${esc(errorText(error))}</p><p>请使用普通浏览模式，并允许此网站保存本地数据。</p><button class="button primary" id="retry">重新打开</button></div>`;
    $('#retry').addEventListener('click', () => location.reload()); return;
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    try {
      // An already installed app is ready offline even if an update check
      // cannot reach the host on the device's current network.
      const existing = await navigator.serviceWorker.getRegistration('./');
      if (existing?.active) {
        offlineReady = true;
        if (page === 'backup') render();
      }
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
      await navigator.serviceWorker.ready;
      offlineReady = true;
      if (page === 'backup') render();
    } catch { /* Local recipes remain usable if offline installation is unavailable. */ }
  }
}
init();
