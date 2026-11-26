// Exercise what a registry consumer gets, without the TypeScript toolchain.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const root = import.meta.dirname + '/..';
const consumer = mkdtempSync(join(tmpdir(), 'envshare-package-'));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npm = (cwd, ...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: 'utf8' });
try {
  const [pack] = JSON.parse(npm(root, 'pack', '--json', '--silent', '--pack-destination', consumer));
  const files = pack.files.map(({ path }) => path);
  const shippedCode = files.filter((path) => !/^(?:package\.json|README\.md|LICEN[SC]E(?:\.\w+)?)$/i.test(path));
  assert.deepEqual(shippedCode.sort(), manifest.files.toSorted());

  writeFileSync(join(consumer, 'package.json'), '{"private":true}\n');
  npm(consumer, 'install', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', './' + pack.filename);
  const tree = JSON.parse(npm(consumer, 'ls', '--all', '--json')).dependencies;
  assert.deepEqual(Object.keys(tree), [manifest.name]);
  assert.deepEqual(Object.keys(tree[manifest.name].dependencies ?? {}), []);

  const run = (...args) => npm(consumer, 'exec', '--offline', '--', 'envshare', ...args);
  assert.match(run('--help'), /envshare encrypt/);
  writeFileSync(join(consumer, '.env'), 'ENVSHARE_KEY=' + Buffer.alloc(32, 1).toString('base64') + '\n');
  writeFileSync(join(consumer, 'share.env'), 'EXAMPLE=packed\n');
  run('encrypt', 'share.env');
  run('sync');
  assert.equal(parseEnv(readFileSync(join(consumer, '.env'), 'utf8')).EXAMPLE, 'packed');
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
