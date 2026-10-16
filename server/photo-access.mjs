import { randomUUID } from 'node:crypto';

const TTL = 120000;
export const photoBusy = () => Object.assign(new Error('图片正在保存或清理，请稍后重试。'), { status: 503, code: 'PHOTO_STORAGE_BUSY' });
// One SQL CAS row coordinates readers (recipe/optimization writes) and an
// exclusive collector across cloud instances. Expired owners cannot renew.
export function photoLeaseState(previous, { action, mode, token, now = Date.now() }) {
  const state = structuredClone(previous || { readers: {}, writer: null });
  state.readers ||= {};
  for (const [id, expiry] of Object.entries(state.readers)) if (expiry <= now) delete state.readers[id];
  if (state.writer?.expires <= now) state.writer = null;
  if (action === 'acquire') {
    if (state.writer || (mode === 'write' && Object.keys(state.readers).length)) throw photoBusy();
    if (mode === 'write') state.writer = { token, expires: now + TTL };
    else { state.readers[token] = now + TTL; state.generation = randomUUID(); }
  } else if (action === 'check') {
    if (mode === 'write' ? state.writer?.token !== token : !state.readers[token]) throw photoBusy();
    if (mode === 'write') state.writer.expires = now + TTL;
    else state.readers[token] = now + TTL;
  } else if (action === 'release') {
    delete state.readers[token]; if (state.writer?.token === token) state.writer = null;
  } else throw new Error('Invalid photo lease action');
  state.version = randomUUID(); return state;
}
export async function photoAccess(store, mode, work) {
  if (!store.photoLease) {
    // Older adapters can still save; destructive collection requires a shared
    // coordination primitive and must never fall back to a process-only lock.
    if (mode === 'write') throw photoBusy();
    return work(async () => {});
  }
  const token = randomUUID();
  const state = await store.photoLease({ action: 'acquire', mode, token });
  const guard = () => store.photoLease({ action: 'check', mode, token });
  guard.generation = state?.generation || 'initial';
  try { return await work(guard); }
  finally { await store.photoLease({ action: 'release', mode, token }).catch(() => {}); }
}
