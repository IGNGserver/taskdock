import { readFile, readdir } from 'node:fs/promises';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const root = resolve('apps/web/dist/assets');
let checked = 0;
for (const name of await readdir(root)) {
  if (!/\.(?:js|css)$/.test(name)) continue;
  const bytes = await readFile(resolve(root, name));
  if (bytes.byteLength < 1024) continue;
  for (const [extension, decompress] of [
    ['gz', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const) {
    const encoded = await readFile(resolve(root, `${name}.${extension}`));
    if (!decompress(encoded).equals(bytes))
      throw new Error(`${name}.${extension} differs from final build bytes`);
    checked++;
  }
}
if (!checked) throw new Error('No precompressed build assets found');
console.log(`PASS: ${checked} static sidecars match final build bytes`);
