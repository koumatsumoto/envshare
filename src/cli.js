#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { appendEntries, parseDotenv, renderEntries } from './dotenv.js';
import { decodeKey, isEnvelope, seal, unseal } from './envelope.js';
import { EnvshareError } from './error.js';
import { readRegular, replaceAtomic, sameFile } from './files.js';
import { gitIgnoreGuard } from './git.js';

const KEY_NAME = 'ENVSHARE_KEY';
const CWD = process.cwd();
const ENV_PATH = resolve('.env');
const ENCRYPTED_PATH = resolve('envshare.enc');
const LOCAL = 'ローカル .env';
const SOURCE = '共有用 dotenv ファイル';
const ENCRYPTED = '暗号ファイル';
const USAGE = '使い方: envshare encrypt <dotenv-source> [--out <path>] または envshare sync [--bootstrap]';

function readLocal() {
  const { bytes, snapshot } = readRegular(ENV_PATH, LOCAL, { optional: true });
  const doc = parseDotenv(bytes, LOCAL);
  if ([...doc.entries.keys()].some((key) => key !== KEY_NAME && key.toUpperCase() === KEY_NAME)) {
    throw new EnvshareError(LOCAL + ' の鍵名は ENVSHARE_KEY と大文字で記述してください。');
  }
  return { doc, snapshot };
}

function sharedEntries(bytes, label) {
  const { entries } = parseDotenv(bytes, label);
  if ([...entries.keys()].some((key) => key.toUpperCase() === KEY_NAME)) {
    throw new EnvshareError(label + ' には ENVSHARE_KEY を含められません。');
  }
  return entries;
}

function selectKey(doc, bootstrap) {
  const local = doc.entries.get(KEY_NAME)?.value;
  const supplied = bootstrap ? process.env[KEY_NAME] : undefined;
  if (bootstrap && supplied === undefined) {
    throw new EnvshareError('--bootstrap には環境変数 ENVSHARE_KEY が必要です。');
  }
  if (local !== undefined && supplied !== undefined && local !== supplied) {
    throw new EnvshareError('.env と環境変数の ENVSHARE_KEY が一致しません。');
  }
  const value = local ?? supplied;
  if (value === undefined) {
    throw new EnvshareError('ローカル .env に ENVSHARE_KEY がありません。');
  }
  return { key: decodeKey(value), remember: local === undefined ? value : undefined };
}

function encrypt(input, output) {
  const local = readLocal();
  const { key } = selectKey(local.doc, false);
  const source = readRegular(input, SOURCE);
  const shared = sharedEntries(source.bytes, SOURCE);
  const previous = readRegular(output, ENCRYPTED + 'の出力先', { optional: true });
  if (input === output || output === ENV_PATH ||
      sameFile(source.snapshot, previous.snapshot) || sameFile(local.snapshot, previous.snapshot)) {
    throw new EnvshareError('共有元または .env を暗号ファイルで上書きできません。');
  }
  if (previous.snapshot && !isEnvelope(previous.bytes)) {
    throw new EnvshareError('暗号ファイルではない既存の出力先を上書きできません。');
  }
  const sourceDirectory = dirname(input);
  const requireLocalIgnored = gitIgnoreGuard(CWD, sourceDirectory);
  requireLocalIgnored?.(ENV_PATH, LOCAL);
  const requireSourceIgnored = sourceDirectory === CWD ? requireLocalIgnored : gitIgnoreGuard(sourceDirectory, CWD);
  requireSourceIgnored?.(input, SOURCE);
  const bytes = seal(Buffer.from(renderEntries(shared)), key);
  replaceAtomic(output, bytes, previous.snapshot, ENCRYPTED);
  console.log('暗号ファイルを作成しました。');
}

function sync(bootstrap) {
  const { doc, snapshot } = readLocal();
  const { key, remember } = selectKey(doc, bootstrap);
  const { bytes } = readRegular(ENCRYPTED_PATH, ENCRYPTED);
  const shared = sharedEntries(unseal(bytes, key), '復号した設定');
  const changed = new Map([...shared].filter(([name, entry]) => doc.entries.get(name)?.value !== entry.value));
  const count = changed.size;
  if (remember !== undefined) changed.set(KEY_NAME, { value: remember, line: KEY_NAME + '=' + remember });
  if (!changed.size) {
    console.log('変更はありません。');
    return;
  }
  const output = appendEntries(doc, changed, LOCAL);
  const requireIgnored = gitIgnoreGuard(CWD);
  requireIgnored?.(ENV_PATH, LOCAL);
  replaceAtomic(ENV_PATH, output, snapshot, LOCAL, {
    mode: 0o600,
    verifyTemporary: (path) => requireIgnored?.(path, '同期の一時ファイル'),
  });
  console.log('同期しました（設定 ' + count + ' 件' + (remember !== undefined ? '、共有鍵を保存' : '') + '）。');
}

function main([command, ...args]) {
  if (command === 'encrypt' &&
      (args.length === 1 || (args.length === 3 && args[1] === '--out' && args[2] && !args[2].startsWith('-'))) &&
      args[0] && !args[0].startsWith('-')) {
    encrypt(resolve(args[0]), args[2] ? resolve(args[2]) : ENCRYPTED_PATH);
  } else if (command === 'sync' && (args.length === 0 || (args.length === 1 && args[0] === '--bootstrap'))) {
    sync(args[0] === '--bootstrap');
  } else if ((command === '--help' || command === '-h') && args.length === 0) {
    console.log(USAGE);
  } else {
    throw new EnvshareError(USAGE);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error('envshare: ' + (error instanceof EnvshareError ? error.message : '処理を完了できませんでした。'));
  process.exitCode = 1;
}
