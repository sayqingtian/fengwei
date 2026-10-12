import { randomUUID } from 'node:crypto';
import { hash } from './database.mjs';
import { isUserId } from './accounts.mjs';

export class Favorites {
  constructor(store, legacyId) { this.store = store; this.legacyId = legacyId; }
  prefix(userId, recipeId) {
    if (!isUserId(userId)) throw new Error('Invalid favorite account');
    return `private/favorites/${userId}/${recipeId === undefined ? '' : `${hash(recipeId)}/`}`;
  }
  async states(userId, recipeId) {
    const prefix = this.prefix(userId, recipeId), accountPrefix = this.prefix(userId);
    const { blobs } = await this.store.list({ prefix, consistency: 'strong' });
    const heads = new Map();
    for (const { key } of blobs) {
      const match = /^([a-f0-9]{64})\/\d{13}-[a-zA-Z0-9-]+\.json$/.exec(key.slice(accountPrefix.length));
      if (match && (!heads.has(match[1]) || key > heads.get(match[1]))) heads.set(match[1], key);
    }
    const states = new Map();
    await Promise.all([...heads.values()].map(async key => {
      const item = await this.store.get(key, { type: 'json', consistency: 'strong' });
      if (item && typeof item.favorite === 'boolean') states.set(item.recipeId, item.favorite);
    }));
    return states;
  }
  value(event, userId, states) {
    return states.has(event.id) ? states.get(event.id) : userId === this.legacyId && !!event.recipe?.favorite;
  }
  async preserveLegacy(event) {
    if (!event?.recipe?.favorite) return;
    // A zero-timestamp baseline can never override an explicit favorite or
    // removal, including concurrent migration and toggle requests.
    await this.store.setJSON(`${this.prefix(this.legacyId, event.id)}0000000000000-legacy.json`, { recipeId: event.id, favorite: true }, { cacheControl: 'no-store' });
  }
  async set(userId, recipeId, favorite, mutationId) {
    const prefix = this.prefix(userId, recipeId);
    const { blobs } = await this.store.list({ prefix, consistency: 'strong' });
    const previous = blobs.find(item => item.key.endsWith(`-${mutationId}.json`));
    if (previous) {
      const event = await this.store.get(previous.key, { type: 'json', consistency: 'strong' });
      if (event.favorite !== favorite) throw Object.assign(new Error('同一次收藏请求的内容发生了变化，请重试。'), { status: 409, code: 'FAVORITE_CONFLICT' });
      return event;
    }
    const event = { recipeId, favorite };
    await this.store.setJSON(`${prefix}${Date.now()}-${randomUUID()}-${mutationId}.json`, event, { cacheControl: 'no-store' });
    return event;
  }
}
