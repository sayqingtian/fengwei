import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
for (const directory of ['dist', 'server', 'scripts']) {
  for (const file of await readdir(directory)) {
    if (!/\.(js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript syntax checks passed.');
