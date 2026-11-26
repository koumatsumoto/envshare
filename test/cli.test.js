import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { seal } from '../src/envelope.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const dummyKey = Buffer.alloc(32, 1).toString('base64');
const otherKey = Buffer.alloc(32, 2).toString('base64');
const sourceName = '.env.share ローカル';
const localName = '.env';
const cipherName = 'envshare.enc';
const headerLength = 10;
const nonceEnd = headerLength + 12;
const tagEnd = nonceEnd + 16;
const platformEnv = Object.fromEntries(
  Object.entries(process.env)
    .filter(([name]) => /^(path|systemroot|windir|temp|tmp|tmpdir)$/i.test(name))
    .map(([name, value]) => [/^path$/i.test(name) ? 'PATH' : name, value]),
);
const keyLine = 'ENVSHARE_KEY=' + dummyKey;

function project(t) {
  const dir = mkdtempSync(join(tmpdir(), 'envshare-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(dir, args, key, extraEnv = {}) {
  const env = { ...platformEnv, HOME: dir, USERPROFILE: dir, ...extraEnv };
  if (key !== undefined) env.ENVSHARE_KEY = key;
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  for (const value of [dummyKey, otherKey, 'DUMMY_SECRET_VALUE', 'DO_NOT_PRINT']) {
    assert.ok(!(result.stdout + result.stderr).includes(value));
  }
  return result;
}

function ok(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
}

function fail(result, message) {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
}

function publish(dir, source = 'EXAMPLE_SETTING=DUMMY_SECRET_VALUE\n') {
  writeFileSync(join(dir, localName), keyLine + '\nLOCAL_ONLY=provider-local\n');
  writeFileSync(join(dir, sourceName), source);
  ok(run(dir, ['encrypt', sourceName]));
  return readFileSync(join(dir, cipherName));
}

function assertUnchanged(path, priorBytes, priorStat) {
  assert.deepEqual(readFileSync(path), priorBytes);
  const now = statSync(path, { bigint: true });
  assert.equal(now.ino, priorStat.ino, 'file was replaced');
  assert.equal(now.mtimeNs, priorStat.mtimeNs, 'file was written');
  assert.equal(now.mode, priorStat.mode, 'permissions changed');
}

test('publish and sync preserve every original byte and append only different values', (t) => {
  const publisher = project(t);
  const recipient = project(t);
  const sealed = publish(publisher, [
    '# private notes are not shared',
    'export SAME = \'same # = value\' # source comment',
    'UPDATE=latest',
    'EMPTY=',
    'EMPTY_AGAIN=""',
    'DUP=first',
    'DUP=second',
    'MULTILINE=\'one\n# literal\ntwo\'',
    'QUOTED=\'a"b\'',
    'EXAMPLE_SETTING=DUMMY_SECRET_VALUE',
    '',
  ].join('\n'));
  assert.ok(!sealed.includes(Buffer.from('DUMMY_SECRET_VALUE')));
  const file = join(recipient, localName);
  const before = [
    '# 受取側のコメント',
    keyLine,
    'SAME = "same # = value"',
    'UPDATE=older',
    'DUP=second',
    'DUP=not-effective',
    'KEEP=mine',
    'EMPTY_AGAIN=',
    '# no trailing newline',
  ].join('\r\n');
  writeFileSync(file, before);
  writeFileSync(join(recipient, cipherName), sealed);

  ok(run(recipient, ['sync'], otherKey)); // No explicit bootstrap: ignore the process env.
  const expected = before + '\r\n' + [
    'UPDATE=latest', 'EMPTY=', 'DUP=second',
    "MULTILINE='one\r\n# literal\r\ntwo'", 'QUOTED=\'a"b\'', 'EXAMPLE_SETTING=DUMMY_SECRET_VALUE', '',
  ].join('\r\n');
  assert.deepEqual(readFileSync(file), Buffer.from(expected));
  const effective = parseEnv(readFileSync(file, 'utf8'));
  assert.equal(effective.EMPTY, '');
  assert.equal(effective.DUP, 'second');
  assert.equal(effective.QUOTED, 'a"b');
  assert.equal(effective.MULTILINE, 'one\n# literal\ntwo');
  assert.ok(!Object.hasOwn(effective, 'LOCAL_ONLY'));

  const snapshot = statSync(file, { bigint: true });
  ok(run(recipient, ['sync']));
  assertUnchanged(file, Buffer.from(expected), snapshot);
  assert.deepEqual(readdirSync(recipient).sort(), [localName, cipherName]);
});

test('missing key fails without stdin, file writes, or implicit environment lookup', (t) => {
  const dir = project(t);
  writeFileSync(join(dir, cipherName), Buffer.alloc(0));
  fail(run(dir, ['sync'], dummyKey), /ENVSHARE_KEY/);
  assert.deepEqual(readdirSync(dir), [cipherName]);
  fail(run(dir, ['sync', '--bootstrap']), /--bootstrap/);
  assert.deepEqual(readdirSync(dir), [cipherName]);
});

test('explicit bootstrap persists the key only after successful authentication', (t) => {
  const cipher = publish(project(t));
  const dir = project(t);
  const file = join(dir, localName);
  writeFileSync(join(dir, cipherName), cipher);
  fail(run(dir, ['sync', '--bootstrap'], otherKey), /認証/);
  fail(run(dir, ['sync', '--bootstrap'], dummyKey + ' '), /標準Base64/);
  assert.ok(!existsSync(file));
  ok(run(dir, ['sync', '--bootstrap'], dummyKey));
  assert.equal(readFileSync(file, 'utf8'), 'EXAMPLE_SETTING=DUMMY_SECRET_VALUE\n' + keyLine + '\n');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const before = readFileSync(file);
  const snapshot = statSync(file, { bigint: true });
  ok(run(dir, ['sync', '--bootstrap'], dummyKey));
  fail(run(dir, ['sync', '--bootstrap'], otherKey), /一致しません/);
  ok(run(dir, ['sync']));
  assertUnchanged(file, before, snapshot);
});

test('bootstrap saves the key even when all settings already match', (t) => {
  const cipher = publish(project(t), 'MATCH=dummy\n');
  const dir = project(t);
  const file = join(dir, localName);
  writeFileSync(join(dir, cipherName), cipher);
  writeFileSync(file, '# local\nMATCH="dummy"');
  if (process.platform !== 'win32') chmodSync(file, 0o644);
  ok(run(dir, ['sync', '--bootstrap'], dummyKey));
  assert.equal(readFileSync(file, 'utf8'), '# local\nMATCH="dummy"\n' + keyLine + '\n');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('wrong key and corruption leave the local file completely unchanged', (t) => {
  const cipher = publish(project(t));
  const dir = project(t);
  const file = join(dir, localName);
  const encryptedFile = join(dir, cipherName);
  const before = Buffer.from(keyLine + '\nKEEP=local\n');
  writeFileSync(file, before);
  const snapshot = statSync(file, { bigint: true });

  writeFileSync(encryptedFile, seal(Buffer.from('SHARED=dummy\n'), Buffer.from(otherKey, 'base64')));
  fail(run(dir, ['sync']), /認証/);
  assertUnchanged(file, before, snapshot);
  for (const index of [0, headerLength, nonceEnd, tagEnd]) {
    const damaged = Buffer.from(cipher);
    damaged[index] ^= 1;
    writeFileSync(encryptedFile, damaged);
    fail(run(dir, ['sync']), /認証/);
    assertUnchanged(file, before, snapshot);
  }
  assert.deepEqual(readdirSync(dir).sort(), [localName, cipherName]);
});

test('shared data must be valid dotenv and cannot contain the reserved key', (t) => {
  const dir = project(t);
  const file = join(dir, localName);
  const encryptedFile = join(dir, cipherName);
  const source = join(dir, sourceName);
  const valid = publish(dir);
  const invalid = [
    { bytes: Buffer.from('export envshare_key=DO_NOT_PRINT\n'), error: /含められません/ },
    { bytes: Buffer.from('A="DO_NOT_PRINT'), error: /dotenv/ },
    { bytes: Buffer.from('\uFEFFA=DO_NOT_PRINT\n'), error: /dotenv/ },
    { bytes: Buffer.from('__proto__=DO_NOT_PRINT\n'), error: /dotenv/ },
    { bytes: Buffer.from('Setting=a\nSETTING=b\n'), error: /dotenv/ },
    { bytes: Buffer.from([0xff, 0x00]), error: /dotenv/ },
  ];
  const before = readFileSync(file);
  const localSnapshot = statSync(file, { bigint: true });
  const sealedSnapshot = statSync(encryptedFile, { bigint: true });
  for (const { bytes, error } of invalid) {
    writeFileSync(source, bytes);
    fail(run(dir, ['encrypt', sourceName]), error);
    assertUnchanged(encryptedFile, valid, sealedSnapshot);
  }
  for (const { bytes, error } of invalid) {
    writeFileSync(encryptedFile, seal(bytes, Buffer.from(dummyKey, 'base64')));
    fail(run(dir, ['sync']), error);
    assertUnchanged(file, before, localSnapshot);
  }
});

test('a local file with ambiguous dotenv syntax is not modified', (t) => {
  const cipher = publish(project(t));
  const dir = project(t);
  const file = join(dir, localName);
  writeFileSync(join(dir, cipherName), cipher);
  for (const contents of [
    '\uFEFF' + keyLine + '\n',
    keyLine + '\nBROKEN "DO_NOT_PRINT"\n',
    keyLine + '\nBROKEN=\'DO_NOT_PRINT\n',
    keyLine + '\nEMPTY= \nDO_NOT_PRINT=dummy\n',
  ]) {
    const before = Buffer.from(contents);
    writeFileSync(file, before);
    const snapshot = statSync(file, { bigint: true });
    fail(run(dir, ['sync']), /dotenv/);
    assertUnchanged(file, before, snapshot);
  }
});

test('encryption uses an explicit source and a fresh nonce without clobbering plaintext', (t) => {
  const dir = project(t);
  const original = publish(dir);
  const localFile = join(dir, localName);
  const before = readFileSync(localFile);
  const source = join(dir, sourceName);
  const sourceBefore = readFileSync(source);
  fail(run(dir, ['encrypt']), /使い方/);
  fail(run(dir, ['encrypt', sourceName, '--out', localName]), /上書き/);
  fail(run(dir, ['encrypt', sourceName, '--out', sourceName]), /上書き/);
  writeFileSync(join(dir, 'another-file'), 'plain\n');
  fail(run(dir, ['encrypt', sourceName, '--out', 'another-file']), /上書き/);
  assert.deepEqual(readFileSync(localFile), before);
  assert.deepEqual(readFileSync(source), sourceBefore);
  assert.equal(readFileSync(join(dir, 'another-file'), 'utf8'), 'plain\n');

  ok(run(dir, ['encrypt', sourceName, '--out', 'alternate.enc']));
  const alternate = readFileSync(join(dir, 'alternate.enc'));
  assert.notDeepEqual(original.subarray(headerLength, nonceEnd), alternate.subarray(headerLength, nonceEnd));
  ok(run(dir, ['encrypt', sourceName]));
  assert.notDeepEqual(original.subarray(headerLength, nonceEnd),
    readFileSync(join(dir, cipherName)).subarray(headerLength, nonceEnd));
});

test('joining dotfiles cannot introduce Windows case-folding collisions', (t) => {
  const cipher = publish(project(t), 'SHARED=next\n');
  const dir = project(t);
  writeFileSync(join(dir, cipherName), cipher);
  const file = join(dir, localName);
  const before = Buffer.from(keyLine + '\nShared=local\n');
  writeFileSync(file, before);
  const snapshot = statSync(file, { bigint: true });
  fail(run(dir, ['sync']), /dotenv/);
  assertUnchanged(file, before, snapshot);

  const alias = Buffer.from(keyLine.replace('ENVSHARE_KEY', 'Envshare_Key') + '\n');
  writeFileSync(file, alias);
  const aliasSnapshot = statSync(file, { bigint: true });
  fail(run(dir, ['sync', '--bootstrap'], dummyKey), /大文字/);
  assertUnchanged(file, alias, aliasSnapshot);
});

const gitName = process.platform === 'win32' ? 'git.exe' : 'git';

function git(dir, args, encoding = 'utf8') {
  return spawnSync(gitName, args, {
    cwd: dir,
    env: { ...platformEnv, HOME: dir, USERPROFILE: dir, GIT_CONFIG_NOSYSTEM: '1' },
    encoding,
    timeout: 10000,
  });
}

function gitProject(t) {
  const root = project(t);
  const init = git(root, ['init', '--quiet']);
  if (init.error?.code === 'ENOENT') {
    t.skip('Git is not installed');
    return undefined;
  }
  assert.equal(init.status, 0, init.stderr);
  return root;
}

test('Git worktrees require the actual .env and private staging path to be ignored', (t) => {
  const root = gitProject(t);
  if (!root) return;
  const dir = join(root, 'project');
  mkdirSync(dir);
  const file = join(dir, localName);
  const ignore = join(root, '.gitignore');
  writeFileSync(join(dir, cipherName), publish(project(t)));
  fail(run(dir, ['sync', '--bootstrap'], dummyKey), /ローカル .env は Git/);
  assert.deepEqual(readdirSync(dir), [cipherName]);

  writeFileSync(ignore, '.env\n');
  fail(run(dir, ['sync', '--bootstrap'], dummyKey), /同期の一時ファイル は Git/);
  assert.deepEqual(readdirSync(dir), [cipherName]);

  writeFileSync(ignore, '.env\n.envshare-tmp-*/\n');
  const before = Buffer.from('KEEP=local\n');
  writeFileSync(file, before);
  const added = git(root, ['add', '-f', '--', 'project/.env']);
  assert.equal(added.status, 0, added.stderr);
  const snapshot = statSync(file, { bigint: true });
  fail(run(dir, ['sync', '--bootstrap'], dummyKey), /追跡されていない無視対象/);
  assertUnchanged(file, before, snapshot);

  const removed = git(root, ['rm', '--cached', '-f', '--', 'project/.env']);
  assert.equal(removed.status, 0, removed.stderr);
  fail(run(dir, ['sync', '--bootstrap'], dummyKey, { PATH: '' }), /Git の無視設定を確認できません/);
  assertUnchanged(file, before, snapshot);

  ok(run(dir, ['sync', '--bootstrap'], dummyKey, {
    GIT_DIR: join(dir, 'unused-git-dir'),
    GIT_INDEX_FILE: join(dir, 'unused-index'),
  }));
  assert.ok(readFileSync(file, 'utf8').includes(keyLine));
  assert.deepEqual(readdirSync(dir).sort(), [localName, cipherName]);
});

test('encryption checks both the key file and the real source worktree', (t) => {
  const publisher = gitProject(t);
  if (!publisher) return;
  const sourceProject = gitProject(t);
  const source = join(sourceProject, sourceName);
  const file = join(publisher, localName);
  writeFileSync(file, keyLine + '\n');
  writeFileSync(source, 'SHARED=DUMMY_SECRET_VALUE\n');
  fail(run(publisher, ['encrypt', source]), /ローカル .env は Git/);
  assert.ok(!existsSync(join(publisher, cipherName)));

  writeFileSync(join(publisher, '.gitignore'), '.env\n');
  fail(run(publisher, ['encrypt', source]), /共有用 dotenv ファイル は Git/);
  assert.ok(!existsSync(join(publisher, cipherName)));
  writeFileSync(join(sourceProject, '.gitignore'), '.env.*\n');
  const autocrlf = git(publisher, ['config', 'core.autocrlf', 'true']);
  assert.equal(autocrlf.status, 0, autocrlf.stderr);
  ok(run(publisher, ['encrypt', source]));
  const encryptedFile = join(publisher, cipherName);
  const bytes = readFileSync(encryptedFile);
  assert.deepEqual(bytes.subarray(0, headerLength), Buffer.from('ENVSHARE1\0', 'ascii'));
  const added = git(publisher, ['add', '--', cipherName]);
  assert.equal(added.status, 0, added.stderr);
  const staged = git(publisher, ['show', ':' + cipherName], 'buffer');
  assert.equal(staged.status, 0);
  assert.deepEqual(staged.stdout, bytes);

  const snapshot = statSync(encryptedFile, { bigint: true });
  const trackedSource = git(sourceProject, ['add', '-f', '--', sourceName]);
  assert.equal(trackedSource.status, 0, trackedSource.stderr);
  fail(run(publisher, ['encrypt', source]), /共有用 dotenv ファイル は Git/);
  assertUnchanged(encryptedFile, bytes, snapshot);
});

test('a tracked case alias cannot receive plaintext or a bootstrap key', (t) => {
  const root = gitProject(t);
  if (!root) return;
  const dir = join(root, 'project');
  mkdirSync(dir);
  const file = join(dir, '.ENV');
  const before = Buffer.from('KEEP=dummy\n');
  writeFileSync(file, before);
  writeFileSync(join(dir, cipherName), publish(project(t)));
  writeFileSync(join(root, '.gitignore'), '.env\n.envshare-tmp-*/\n');
  const config = git(root, ['config', 'core.ignoreCase', 'true']);
  assert.equal(config.status, 0, config.stderr);
  const added = git(root, ['add', '-f', '--', 'project/.ENV']);
  assert.equal(added.status, 0, added.stderr);

  const snapshot = statSync(file, { bigint: true });
  fail(run(dir, ['sync', '--bootstrap'], dummyKey), /追跡されていない無視対象/);
  assertUnchanged(file, before, snapshot);
  assert.deepEqual(readdirSync(dir).sort(), ['.ENV', cipherName]);
});

test('the working tree is not searched for an executable Git', (t) => {
  const root = gitProject(t);
  if (!root) return;
  const aliasedPath = join(project(t), 'worktree-alias');
  const installed = (platformEnv.PATH ?? '').split(delimiter)
    .map((dir) => join(dir.replace(/^"(.*)"$/, '$1'), gitName))
    .find((path) => existsSync(path));
  assert.ok(installed);
  try {
    symlinkSync(installed, join(root, gitName), 'file');
    symlinkSync(root, aliasedPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows runner does not permit file symlinks');
    return;
  }
  writeFileSync(join(root, cipherName), publish(project(t)));
  writeFileSync(join(root, '.gitignore'), '.env\n.envshare-tmp-*/\n');
  for (const path of [root, aliasedPath]) {
    fail(run(root, ['sync', '--bootstrap'], dummyKey, { PATH: path }), /Git の無視設定を確認できません/);
    assert.ok(!existsSync(join(root, localName)));
  }
});

test('non-regular input and output paths are refused', (t) => {
  const dir = project(t);
  publish(dir);
  mkdirSync(join(dir, 'directory'));
  fail(run(dir, ['encrypt', 'directory']), /通常のファイル/);
  fail(run(dir, ['encrypt', sourceName, '--out', 'directory']), /通常のファイル/);
});

test('on Windows a read-only destination fails without changes', { skip: process.platform !== 'win32' }, (t) => {
  const dir = project(t);
  const file = join(dir, localName);
  const before = Buffer.from(keyLine + '\nKEEP=dummy\n');
  writeFileSync(file, before);
  writeFileSync(join(dir, cipherName), publish(project(t)));
  chmodSync(file, 0o444);
  try {
    const snapshot = statSync(file, { bigint: true });
    fail(run(dir, ['sync']), /書き込めません/);
    assertUnchanged(file, before, snapshot);
  } finally {
    chmodSync(file, 0o600);
  }
});

test('symbolic links are refused without touching their targets', (t) => {
  const publisher = project(t);
  const cipher = publish(publisher);
  const dir = project(t);
  const protectedFile = join(dir, 'protected');
  const before = Buffer.from(keyLine + '\nKEEP=dummy\n');
  writeFileSync(protectedFile, before);
  writeFileSync(join(dir, cipherName), cipher);
  try {
    symlinkSync(protectedFile, join(dir, localName), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows runner does not permit file symlinks');
    return;
  }
  fail(run(dir, ['sync']), /通常のファイル/);
  symlinkSync(protectedFile, join(publisher, 'link'), 'file');
  fail(run(publisher, ['encrypt', 'link']), /通常のファイル/);
  fail(run(publisher, ['encrypt', sourceName, '--out', 'link']), /通常のファイル/);
  assert.deepEqual(readFileSync(protectedFile), before);
});
