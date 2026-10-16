import { hash } from './database.mjs';

// Local development is a single process. Cloud stores implement this operation
// with a conditional SQL update, shared by every function instance.
const localLimits = new WeakMap();
export class RateLimits {
  constructor(store) { this.store = store; if (!localLimits.has(store)) localLimits.set(store, new Map()); }
  async consume(scope, identity, limit, windowMs, code, message) {
    const key = `private/rate-limits/${scope}/${hash(String(identity))}.json`;
    const now = Date.now();
    let result;
    if (this.store.consumeRateLimit) result = await this.store.consumeRateLimit(key, { limit, windowMs, now });
    else {
      const values = localLimits.get(this.store);
      for (const [key, value] of values) if (value.expires <= now) values.delete(key);
      const previous = values.get(key), value = previous?.expires > now ? previous : { count: 0, expires: now + windowMs };
      result = { allowed: value.count < limit, retryAfter: Math.max(1, Math.ceil((value.expires - now) / 1000)) };
      if (result.allowed) { value.count++; values.set(key, value); }
    }
    if (!result.allowed) throw Object.assign(new Error(message), { status: 429, code, retryAfter: result.retryAfter });
  }
}
