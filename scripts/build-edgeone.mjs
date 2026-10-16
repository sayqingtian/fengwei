import { cp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { makeZip } from './zip.mjs';
import { stampVersion } from './app-version.mjs';

const output = resolve('artifacts', 'fengwei-edgeone');
await mkdir(output, { recursive: true });
await cp('dist', output, { recursive: true });
const version = await stampVersion(resolve('dist'), output);
const functionFile = resolve(output, 'cloud-functions', 'api', '[[default]].js');
await mkdir(resolve(output, 'cloud-functions', 'api'), { recursive: true });
await build({ entryPoints: ['cloud-functions/api/[[default]].js'], outfile: functionFile, bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: false });
await writeFile(resolve(output, 'cloud-functions', 'package.json'), JSON.stringify({ type: 'module' }));
// Direct uploads accept routing/header settings, not Git build settings.
const { headers } = JSON.parse(await readFile('edgeone.json', 'utf8'));
await writeFile(resolve(output, 'edgeone.json'), JSON.stringify({ headers }, null, 2));
await writeFile(resolve(output, 'cloud-functions', 'SDK-LICENSE.txt'), 'Includes @edgeone/pages-blob 0.0.18, licensed under the MIT License.\nhttps://www.npmjs.com/package/@edgeone/pages-blob\n');
const bundle = await readFile(functionFile, 'utf8');
if (!bundle.includes('{{PAGES_BLOB_DEPLOY_CREDENTIAL}}')) throw new Error('Missing automatic EdgeOne Blob credential placeholder.');
if (/from ["']@edgeone/.test(bundle)) throw new Error('SDK dependency was not bundled.');
const manifest = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else { const content = await readFile(path); manifest.push({ file: relative(output, path).replaceAll('\\', '/'), bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }); }
  }
}
await walk(output);
if (manifest.some(item => /(^|\/)(\.env|\.data|node_modules|tests|artifacts)(\/|$)/.test(item.file))) throw new Error('Private/development files found in upload artifacts.');
await writeFile(resolve('artifacts', 'fengwei-build-manifest.json'), JSON.stringify(manifest, null, 2));
const entries = await Promise.all(manifest.map(async item => ({ name: item.file, content: await readFile(resolve(output, item.file)) })));
const currentZip = makeZip(entries);
const legacyZip = makeZip(entries.map(item => ({ ...item, name: item.name.replace(/^cloud-functions\//, 'node-functions/') })));
await writeFile(resolve('artifacts', 'fengwei-edgeone.zip'), currentZip);
await writeFile(resolve('artifacts', 'fengwei-edgeone-multiuser.zip'), currentZip);
await writeFile(resolve('artifacts', 'fengwei-edgeone-legacy.zip'), legacyZip);
await writeFile(resolve('artifacts', 'fengwei-edgeone-multiuser-legacy.zip'), legacyZip);
console.log(`Prepared EdgeOne upload folder: ${output}`);
console.log(`Application version: ${version}`);
console.log('Created fengwei-edgeone.zip and the legacy node-functions compatibility ZIP.');
console.log('Backend and storage SDK are bundled; no platform npm install is required.');
