import createAvif from '@jsquash/avif/codec/enc/avif_enc.js';
import { defaultOptions } from '@jsquash/avif/meta.js';

let avif;
const TARGET = 80 * 1024, MAXIMUM = 160 * 1024;
async function encode(bitmap, progress) {
  let best;
  const rounds = [[1280, 52, .76], [1280, 44, .64], [1024, 44, .64], [800, 40, .60]];
  for (let index = 0; index < rounds.length; index++) {
    const [edge, quality, webpQuality] = rounds[index];
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height), ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bitmap, 0, 0, width, height);
    progress(`正在优化照片 ${index + 1}/${rounds.length}…`);
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality: webpQuality });
    const candidates = [{ bytes: new Uint8Array(await webp.arrayBuffer()), type: webp.type, width, height }];
    try {
      avif ||= createAvif({ locateFile: () => new URL('./avif-encoder.wasm', import.meta.url).href });
      const module = await avif, pixels = ctx.getImageData(0, 0, width, height);
      const bytes = module.encode(new Uint8Array(pixels.data.buffer), width, height, { ...defaultOptions, quality, speed: 6, subsample: 1 });
      if (bytes?.length) candidates.push({ bytes: new Uint8Array(bytes), type: 'image/avif', width, height });
    } catch { avif = null; }
    for (const candidate of candidates) if (!best || candidate.bytes.length < best.bytes.length) best = candidate;
    if (best.bytes.length <= TARGET) break;
  }
  if (!best || best.bytes.length > MAXIMUM) throw new Error('照片细节过多，请裁剪后再试。');
  return best;
}
self.onmessage = async ({ data: { file, id } }) => {
  let bitmap;
  try {
    if (file.size > 20 * 1024 * 1024 || !file.type.startsWith('image/')) throw new Error('请选择不超过 20 MB 的照片。');
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 60000000) throw new Error('照片尺寸过大，请先裁剪照片。');
    const result = await encode(bitmap, message => self.postMessage({ id, progress: message }));
    self.postMessage({ id, ...result, originalBytes: file.size }, [result.bytes.buffer]);
  } catch (error) { self.postMessage({ id, error: error.message || '照片处理失败，请改用 JPEG、PNG 或 WebP。' }); }
  finally { bitmap?.close(); }
};
