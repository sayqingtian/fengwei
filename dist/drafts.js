const PREFIX = 'fengwei-drafts-v1:';
const owner = id => typeof id === 'string' && /^usr_[a-f0-9]{32}$/.test(id);

// Synchronous storage also works in pagehide, where an IndexedDB transaction
// may not finish before the mobile browser suspends the page.
export function createDraftStore(storage) {
  const key = id => { if (!owner(id)) throw new Error('请先登录后保存草稿。'); return PREFIX + id; };
  function list(userId) {
    if (!owner(userId)) return [];
    const raw = storage.getItem(key(userId));
    if (!raw) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error('本机草稿格式不正确，请先导出或清除此网站数据。');
    return items.filter(item => item?.version === 1 && item.userId === userId && typeof item.recipe?.id === 'string' && Array.isArray(item.recipe.ingredients) && Array.isArray(item.recipe.steps)).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }
  return {
    list,
    save(userId, draft) {
      const item = { ...structuredClone(draft), version: 1, userId, savedAt: new Date().toISOString() };
      storage.setItem(key(userId), JSON.stringify([item, ...list(userId).filter(previous => previous.recipe.id !== draft.recipe.id)]));
      return item;
    },
    remove(userId, id) {
      const remaining = list(userId).filter(item => item.recipe.id !== id);
      if (remaining.length) storage.setItem(key(userId), JSON.stringify(remaining)); else storage.removeItem(key(userId));
    },
    clear(userId) { if (owner(userId)) storage.removeItem(key(userId)); },
  };
}
