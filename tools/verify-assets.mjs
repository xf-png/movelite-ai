import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const base = process.argv[2] ? new URL(process.argv[2]) : null;
const assets = [];
for (const name of ['model-assets.json']) {
  const manifest = JSON.parse(await readFile(resolve(root, name), 'utf8'));
  assert.ok(manifest.assets.length > 0, `${name}: empty resource manifest`);
  for (const asset of manifest.assets) {
    const file = resolve(root, asset.path);
    assert.ok(file.startsWith(root.endsWith(sep) ? root : root + sep), 'Resource must stay within dist');
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assets.push(asset);
  }
}
assert.equal(new Set(assets.map(asset => asset.path)).size, assets.length, 'Unique asset paths');
let next = 0;
let checked = 0;
async function verify() {
  while (next < assets.length) {
    const asset = assets[next++];
    const local = await readFile(resolve(root, asset.path));
    assert.equal(local.length, asset.bytes, `${asset.path}: local byte length`);
    assert.equal(createHash('sha256').update(local).digest('hex'), asset.sha256, `${asset.path}: local SHA256`);
    if (base) {
      const url = new URL(asset.path, base);
      assert.equal(url.origin, base.origin, 'Every resource must have the website origin');
      let response;
      let remote;
      try {
        // Model/WASM files are tens of MB; a short text-file deadline can
        // incorrectly fail a working download on a slower connection.
        response = await fetch(url, { signal: AbortSignal.timeout(asset.bytes > 1024 * 1024 ? 300000 : 45000) });
        assert.equal(response.status, 200, `${asset.path}: public HTTP status`);
        remote = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw new Error(`${asset.path}: public download failed (${error.message})`, { cause: error });
      }
      assert.equal(remote.length, asset.bytes, `${asset.path}: public byte length`);
      assert.equal(createHash('sha256').update(remote).digest('hex'), asset.sha256, `${asset.path}: public SHA256`);
      if (/\.(js|mjs)$/.test(asset.path)) assert.match(response.headers.get('content-type'), /javascript/, 'Module MIME');
      if (asset.path.endsWith('.wasm')) assert.match(response.headers.get('content-type'), /application\/wasm/, 'WASM MIME');
    }
    checked++;
    if (checked % 40 === 0) console.log(`Verified ${checked}/${assets.length} bundled resources`);
  }
}
await Promise.all(Array.from({ length: base ? 8 : 2 }, verify));
console.log(JSON.stringify({ pass: true, resources: checked, bytes: assets.reduce((total, asset) => total + asset.bytes, 0), origin: base?.href ?? 'local files' }));

