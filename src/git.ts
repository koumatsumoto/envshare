import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { EnvshareError } from './error.ts';

const statOptions = { throwIfNoEntry: false } as const;

function gitProjectRoot(cwd: string) {
  for (let directory = cwd;; directory = dirname(directory)) {
    const path = join(directory, '.git');
    const marker = lstatSync(path, statOptions);
    // A linked worktree may have a .git file. An empty directory is not a repository.
    if (marker && (!marker.isDirectory() || lstatSync(join(path, 'HEAD'), statOptions) ||
        lstatSync(join(path, 'config'), statOptions))) return directory;
    if (directory === dirname(directory)) return undefined;
  }
}

function within(directory: string, path: string) {
  const distance = relative(directory, path);
  return !isAbsolute(distance) && distance !== '..' && !distance.startsWith('..' + sep);
}

function findGit(env: NodeJS.ProcessEnv, projectRoots: string[]) {
  const path = Object.entries(env).find(([name]) => /^path$/i.test(name))?.[1] ?? '';
  const bin = process.platform === 'win32' ? 'git.exe' : 'git';
  const inProject = (name: string) => projectRoots.some((root) => within(root, name));
  for (const entry of path.split(delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory) || inProject(directory)) continue;
    try {
      // Resolve the directory separately: a repo's git symlink may point back
      // outside the repo, hiding its location if only the leaf is resolved.
      const physicalDirectory = realpathSync(directory);
      if (inProject(physicalDirectory)) continue;
      const candidate = join(physicalDirectory, bin);
      if (!statSync(candidate).isFile() || inProject(realpathSync(candidate))) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue in PATH order; never use an implicit or relative entry.
    }
  }
}

export function gitIgnoreGuard(cwd: string, secondProject = cwd) {
  const unavailable = () => new EnvshareError('Git の無視設定を確認できません。Git と作業ツリーを確認してください。');
  let projectRoot;
  let otherRoot;
  let physicalDirectory;
  try {
    physicalDirectory = realpathSync(cwd);
    projectRoot = gitProjectRoot(physicalDirectory);
    if (!projectRoot) return undefined;
    if (secondProject !== cwd) otherRoot = gitProjectRoot(realpathSync(secondProject));
  } catch {
    throw unavailable();
  }

  // A bootstrap key and Git configuration overrides are not passed to Git.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|home|homedrive|homepath|userprofile|systemroot|windir|localappdata|xdg_config_home|temp|tmp|tmpdir)$/i.test(name)));
  const git = findGit(env, otherRoot ? [projectRoot, otherRoot] : [projectRoot]);
  if (!git) throw unavailable();

  const status = (args: string[]) => {
    const result = spawnSync(git, args, {
      cwd: projectRoot, env, stdio: 'ignore', windowsHide: true, timeout: 5000,
    });
    if (result.error || (result.status !== 0 && result.status !== 1)) throw unavailable();
    return result.status;
  };

  return (path: string, label: string) => {
    if (!within(cwd, path)) throw unavailable();
    const target = join(physicalDirectory, relative(cwd, path));
    const name = relative(projectRoot, target).split(sep).join('/');
    // check-ignore may miss aliases in the case-insensitive index. Check the
    // literal name case-insensitively from the root, even on a case-sensitive OS.
    const tracked = status(['ls-files', '--error-unmatch', '--', ':(icase,literal)' + name]) === 0;
    const ignored = !tracked && status(['check-ignore', '-q', '--', './' + name]) === 0;
    if (!ignored) {
      throw new EnvshareError(label + ' は Git に追跡されていない無視対象にしてください。');
    }
  };
}
