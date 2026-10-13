import { joinPhoto, splitPhoto } from './photo-wire.js';
let worker, active = new Map(), nextId = 0, queue = Promise.resolve();
function resetWorker(error) {
  worker?.terminate(); worker = null;
  for (const job of active.values()) { clearTimeout(job.timer); job.reject(error); }
  active.clear();
}
function run(file, onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./codecs/photo-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const job = active.get(data.id); if (!job) return;
      if (data.progress) { job.onProgress?.(data.progress); return; }
      active.delete(data.id); clearTimeout(job.timer);
      if (data.error) job.reject(new Error(data.error));
      else job.resolve({ photo: joinPhoto(data), bytes: data.bytes.length, originalBytes: data.originalBytes, width: data.width, height: data.height, type: data.type });
    };
    worker.onerror = () => resetWorker(new Error('图片处理组件未能加载，请联网刷新后重试。'));
  }
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => resetWorker(new Error('照片处理时间较长，请裁剪后重试。')), 60000);
    active.set(id, { resolve, reject, timer, onProgress }); worker.postMessage({ file, id });
  });
}
export function compressPhoto(file, onProgress) {
  const pending = queue.then(() => run(file, onProgress)); queue = pending.catch(() => {}); return pending;
}
export async function optimizeDataPhoto(photo, onProgress) {
  const source = splitPhoto(photo);
  const result = await compressPhoto(new Blob([source.bytes], { type: source.type }), onProgress);
  // Never enlarge a small existing image during imports or bulk optimization.
  return result.bytes < source.bytes.length ? result : { photo, bytes: source.bytes.length, originalBytes: source.bytes.length, type: source.type };
}
export const photoSize = bytes => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
