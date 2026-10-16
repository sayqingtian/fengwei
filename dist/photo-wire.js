export const PHOTO_PACKET_TYPE = 'application/vnd.fengwei.photos';
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export function splitPhoto(photo) {
  const match = /^data:(image\/(?:jpeg|png|webp|avif));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(photo);
  if (!match) throw new Error('照片格式不正确');
  const raw = atob(match[2]);
  return { type: match[1], bytes: Uint8Array.from(raw, char => char.charCodeAt(0)) };
}
export function joinPhoto({ type, bytes }) {
  if (!PHOTO_TYPES.includes(type)) throw new Error('照片格式不正确');
  let raw = '';
  for (let i = 0; i < bytes.length; i += 32768) raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${type};base64,${btoa(raw)}`;
}
export function packPhotos(metadata, photos = []) {
  const header = encoder.encode(JSON.stringify({ metadata, photos: photos.map(({ type, bytes }) => ({ type, size: bytes.length })) }));
  const output = new Uint8Array(8 + header.length + photos.reduce((sum, photo) => sum + photo.bytes.length, 0));
  output.set([70, 87, 80, 49]); new DataView(output.buffer).setUint32(4, header.length);
  output.set(header, 8); let offset = 8 + header.length;
  for (const photo of photos) { output.set(photo.bytes, offset); offset += photo.bytes.length; }
  return output;
}
export function unpackPhotos(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8 || bytes.length > 6 * 1024 * 1024 || bytes[0] !== 70 || bytes[1] !== 87 || bytes[2] !== 80 || bytes[3] !== 49) throw new Error('照片数据不完整');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (length > 200000 || length + 8 > bytes.length) throw new Error('照片信息不完整');
  const { metadata, photos } = JSON.parse(decoder.decode(bytes.subarray(8, 8 + length)));
  if (!Array.isArray(photos) || photos.length > 8) throw new Error('照片数量不正确');
  let offset = 8 + length;
  const images = photos.map(({ type, size }) => {
    if (!PHOTO_TYPES.includes(type) || !Number.isSafeInteger(size) || size < 1 || offset + size > bytes.length) throw new Error('照片内容不完整');
    const photo = { type, bytes: bytes.slice(offset, offset + size) }; offset += size; return photo;
  });
  if (offset !== bytes.length) throw new Error('照片数据长度不正确');
  return { metadata, photos: images };
}
