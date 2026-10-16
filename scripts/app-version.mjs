import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// A content change always produces a new installed shell, even if nobody
// remembered to increment a service-worker cache string in the source.
export async function stampVersion(source, output) {
  const digest = createHash('sha256');
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = resolve(directory, entry.name), name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path, `${name}/`);
      else { digest.update(name); digest.update('\0'); digest.update(await readFile(path)); digest.update('\0'); }
    }
  }
  await walk(source);
  const current = JSON.parse(await readFile(resolve(source, 'version.json'), 'utf8')).version;
  const version = `${current.split('.').slice(0, 3).join('.')}.${parseInt(digest.digest('hex').slice(0, 12), 16)}`;
  for (const file of ['sw.js', 'update.js']) {
    let text = await readFile(resolve(source, file), 'utf8');
    if (!text.includes(`'${current}'`)) throw new Error(`Version does not match in ${file}`);
    text = text.replace(`'${current}'`, `'${version}'`);
    if (file === 'sw.js') text = text.replace(/const CACHE = '[^']+';/, `const CACHE = 'fengwei-shell-${version}';`);
    await writeFile(resolve(output, file), text);
  }
  await writeFile(resolve(output, 'version.json'), JSON.stringify({ version }));
  return version;
}
