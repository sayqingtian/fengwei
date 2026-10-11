export const CATEGORIES = ['家常菜', '下饭菜', '汤羹', '早餐', '烘焙', '甜点', '饮品', '其他'];
export const BACKUP_FORMAT = 'shiwei-recipes';
export const BACKUP_VERSION = 1;
const MAX_TEXT = 12000;
export const createId = () => globalThis.crypto?.randomUUID?.() || `recipe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export const isPhoto = value => typeof value === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(value) && value.length <= 8000000;

function string(value, label, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式不正确或内容过长`);
  return value.trim();
}

export function validateRecipe(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('菜谱格式不正确');
  const id = string(raw.id, '菜谱编号', 128);
  const title = string(raw.title, '菜名', 80);
  if (!id || !title) throw new Error('菜谱缺少编号或菜名');
  const category = string(raw.category, '分类', 30) || '其他';
  const description = string(raw.description ?? '', '简介', 300);
  const notes = string(raw.notes ?? '', '心得');
  if (!Number.isInteger(raw.minutes) || raw.minutes < 0 || raw.minutes > 1440) throw new Error('用时必须是 0 到 1440 的整数');
  if (!Number.isInteger(raw.servings) || raw.servings < 1 || raw.servings > 100) throw new Error('份量必须是 1 到 100 的整数');
  if (typeof raw.favorite !== 'boolean') throw new Error('收藏状态格式不正确');
  if (!Array.isArray(raw.ingredients) || raw.ingredients.length > 100) throw new Error('食材格式不正确');
  const ingredients = raw.ingredients.map(item => {
    if (!item || typeof item !== 'object') throw new Error('食材格式不正确');
    const name = string(item.name, '食材名', 100);
    if (!name) throw new Error('食材名不能为空');
    return { name, amount: string(item.amount ?? '', '食材用量', 100) };
  });
  if (!Array.isArray(raw.steps) || raw.steps.length > 100) throw new Error('步骤格式不正确');
  const steps = raw.steps.map(item => {
    const text = string(item, '步骤');
    if (!text) throw new Error('步骤不能为空');
    return text;
  });
  if (raw.photo && !isPhoto(raw.photo)) throw new Error('照片格式不受支持或文件过大');
  for (const field of ['createdAt', 'updatedAt']) {
    if (typeof raw[field] !== 'string' || !Number.isFinite(Date.parse(raw[field]))) throw new Error('菜谱日期格式不正确');
  }
  return { id, title, category, description, minutes: raw.minutes, servings: raw.servings, favorite: raw.favorite, photo: raw.photo || '', ingredients, steps, notes, createdAt: raw.createdAt, updatedAt: raw.updatedAt };
}

export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('文件无法读取，请选择拾味导出的 JSON 备份'); }
  if (data?.format !== BACKUP_FORMAT || data?.version !== BACKUP_VERSION || !Array.isArray(data.recipes)) throw new Error('这不是受支持的拾味备份文件');
  if (data.recipes.length > 10000) throw new Error('单次最多导入 10000 道菜谱');
  const recipes = data.recipes.map(validateRecipe);
  if (new Set(recipes.map(item => item.id)).size !== recipes.length) throw new Error('备份中包含重复编号，请检查文件');
  return recipes;
}

export function makeBackup(recipes) {
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), recipes: recipes.map(validateRecipe) }, null, 2);
}

export function planImport(current, incoming) {
  const map = new Map(current.map(item => [item.id, item]));
  const writes = [];
  let added = 0, updated = 0, skipped = 0;
  for (const item of incoming) {
    const existing = map.get(item.id);
    if (!existing) { added++; writes.push(item); }
    else if (Date.parse(item.updatedAt) > Date.parse(existing.updatedAt)) { updated++; writes.push(item); }
    else skipped++;
  }
  return { writes, added, updated, skipped };
}

export function filterRecipes(recipes, { query = '', category = '全部', favorites = false, sort = 'updated' } = {}) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return recipes.filter(item => {
    const haystack = [item.title, item.category, item.description, item.notes, ...item.ingredients.map(ingredient => ingredient.name)].join(' ').toLocaleLowerCase();
    return (!favorites || item.favorite) && (category === '全部' || item.category === category) && terms.every(term => haystack.includes(term));
  }).sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function openStore() {
  const db = await new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器无法保存菜谱，请使用 Safari 普通浏览模式')); return; }
    const request = indexedDB.open('shiwei-private-recipes', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('recipes', { keyPath: 'id' });
      database.createObjectStore('settings');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他拾味页面后重试'));
  });
  db.onversionchange = () => db.close();
  function operation(storeName, mode, execute) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      let result;
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('保存失败，请重试'));
      transaction.onabort = () => reject(transaction.error || new Error('保存已中止'));
      try { execute(transaction.objectStore(storeName), value => { result = value; }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  }
  return {
    all: () => operation('recipes', 'readonly', (store, set) => { const req = store.getAll(); req.onsuccess = () => set(req.result); }),
    put: recipe => { const valid = validateRecipe(recipe); return operation('recipes', 'readwrite', store => store.put(valid)); },
    remove: id => operation('recipes', 'readwrite', store => store.delete(id)),
    import: recipes => { const valid = recipes.map(validateRecipe); return operation('recipes', 'readwrite', store => valid.forEach(item => store.put(item))); },
    setting: key => operation('settings', 'readonly', (store, set) => { const req = store.get(key); req.onsuccess = () => set(req.result); }),
    setSetting: (key, value) => operation('settings', 'readwrite', store => store.put(value, key))
  };
}
