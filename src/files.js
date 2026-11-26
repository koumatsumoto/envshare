import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync,
  openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { EnvshareError } from './error.js';

const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const statOptions = { bigint: true, throwIfNoEntry: false };
const snapshotFields = ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'];

function sameSnapshot(a, b) {
  if (!a || !b) return a === b;
  return snapshotFields.every((field) => a[field] === b[field]);
}

export function sameFile(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

export function readRegular(path, label, { optional = false } = {}) {
  const invalid = () => new EnvshareError(label + ' は通常のファイルである必要があります。');
  const changed = () => new EnvshareError(label + ' が読み取り中に変更されました。再実行してください。');
  let fd;
  try {
    const snapshot = lstatSync(path, statOptions);
    if (!snapshot && optional) return { bytes: Buffer.alloc(0), snapshot };
    if (!snapshot) throw new EnvshareError(label + ' が見つかりません。');
    if (!snapshot.isFile()) throw invalid();
    fd = openSync(path, READ_FLAGS);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameSnapshot(snapshot, opened)) throw changed();
    const bytes = readFileSync(fd);
    if (!sameSnapshot(snapshot, fstatSync(fd, { bigint: true }))) throw changed();
    return { bytes, snapshot };
  } catch (error) {
    if (error instanceof EnvshareError) throw error;
    throw new EnvshareError(label + ' を読み取れません。');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function replaceAtomic(path, bytes, snapshot, label, { mode, verifyTemporary } = {}) {
  let directory;
  let temporary;
  try {
    directory = mkdtempSync(join(dirname(path), '.envshare-tmp-'));
    temporary = join(directory, 'output');
    verifyTemporary?.(temporary);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (process.platform !== 'win32') {
      const permissions = mode ?? (snapshot && Number(snapshot.mode & 0o777n)) ?? 0o600;
      chmodSync(temporary, permissions);
    }
    if (!sameSnapshot(snapshot, lstatSync(path, statOptions))) {
      throw new EnvshareError(label + ' が処理中に変更されました。再実行してください。');
    }
    renameSync(temporary, path);
    temporary = undefined;
  } catch (error) {
    if (error instanceof EnvshareError) throw error;
    throw new EnvshareError(label + ' を書き込めません。');
  } finally {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (directory) {
      try {
        rmdirSync(directory);
      } catch (error) {
        // After rename, only the empty directory remains; the update succeeded.
        if (temporary) throw error;
      }
    }
  }
}
