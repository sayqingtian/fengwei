import { mkdir, readFile, writeFile, readdir, link, unlink, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';

// Local development only. The cloud deployment uses EdgeOne Blob instead.
export class FileStore {
  constructor(root) { this.root = resolve(root); }
  path(key) { const path = resolve(this.root, key); if (!path.startsWith(this.root + sep)) throw new Error('Invalid storage key'); return path; }
  async set(key, value, options = {}) {
    const path = this.path(key); await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try { if (options.onlyIfNew) await link(temporary, path); else await rename(temporary, path); }
    catch (error) { if (error.code === 'EEXIST') error.code = 'PRECONDITION_FAILED'; throw error; }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  setJSON(key, value, options) { return this.set(key, JSON.stringify(value), options); }
  async get(key, options = {}) {
    try { const value = await readFile(this.path(key), 'utf8'); return options.type === 'json' ? JSON.parse(value) : value; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async list({ prefix = '' } = {}) {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    return { blobs: entries.filter(item => item.isFile() && !item.name.endsWith('.tmp')).map(item => ({ key: resolve(item.parentPath || item.path, item.name).slice(this.root.length + 1).replaceAll('\\', '/') })).filter(item => item.key.startsWith(prefix)) };
  }
}
