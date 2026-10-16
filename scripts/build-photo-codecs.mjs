import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('dist/codecs', { recursive: true });
await build({ entryPoints: ['scripts/photo-worker.mjs'], outfile: 'dist/codecs/photo-worker.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true });
await copyFile('node_modules/@jsquash/avif/codec/enc/avif_enc.wasm', 'dist/codecs/avif-encoder.wasm');
await copyFile('node_modules/@jsquash/avif/LICENSE', 'dist/codecs/AVIF-LICENSE.txt');
await writeFile('dist/codecs/LICENSE.txt', 'AVIF encoder: @jsquash/avif 2.1.1, Apache-2.0. Includes libavif/libaom.\nhttps://github.com/jamsinclair/jSquash/tree/main/packages/avif\n');
