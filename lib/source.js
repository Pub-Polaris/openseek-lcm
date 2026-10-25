/**
 * Which checkout the plugin is running from, and how to move it.
 *
 * The desktop profile links this repository, so the branch in the working tree
 * *is* the installed code: switching is a git operation, not a reinstall, and it
 * needs no pnpm run. It only takes effect after a restart, because the Cordis
 * loader keeps the module generation it first imported -- so every successful
 * switch reports `restartRequired` rather than claiming the change is live.
 *
 * The git calls are deliberately narrow. A dirty tree is refused instead of
 * stashed: the working tree here is the developer's own, and a silent stash is
 * the kind of help that costs someone an afternoon. Only the three release
 * branches are offered, because a name outside them is not a path anyone should
 * reach by clicking.
 *
 * @module openseek-lcm/source
 */

import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The repository root, derived from this module's own location. */
export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The branches the control offers, in the order it shows them.
 *
 * `summary` is the one line the UI puts under each choice: what kind of code it
 * is, in the words a user needs to pick, not a description of the branch model.
 */
export const SOURCE_BRANCHES = Object.freeze([
  Object.freeze({
    name: 'main',
    summary: '主分支。适合追求近乎稳定的用户，此分支改动相对谨慎。',
  }),
  Object.freeze({
    name: 'dev',
    summary:
      '开发分支。适合想尝鲜新功能、或与 opencode-lcm 上游相关更新后需要做代码修订的用户级测试。可能有破坏性更新。',
  }),
  Object.freeze({
    name: 'polaris',
    summary:
      '北极星分支。必然对当前缓存产生重大影响与改动（会导致缓存失效），适合非正式开发环境测试与尝鲜；此处为实验性代码，随时会被移除。',
  }),
]);

/**
 * Where the running copy can come from.
 *
 * `local` switches this checkout -- seconds, works offline, and the code stays
 * editable. `github` has the profile install that branch with pnpm: the only way
 * to run without a local clone, at the cost of a network install and a lockfile
 * change on every switch.
 */
export const SOURCE_MODES = Object.freeze([
  Object.freeze({ id: 'local', summary: '本地仓库。秒级切换，可离线，能直接改代码。' }),
  Object.freeze({ id: 'github', summary: 'GitHub 分支。不依赖本地克隆，每次切换要联网重装。' }),
]);

/** The package spec that installs one branch straight from GitHub. */
export function gitHubSpec(branch) {
  return `github:Pub-Polaris/openseek-lcm#${branch}`;
}

/**
 * Read the checkout behind the running plugin.
 *
 * Fails soft: an npm-installed copy has no `.git` above it, and reporting that as
 * a plain "not a checkout" is better than throwing into a command handler.
 *
 * @param {string} [repoDir]
 * @returns {Promise<{ok: true, branch: string, sha: string, dirty: string[],
 *   branches: Array<{name: string, summary: string}>}
 *   | {ok: false, reason: string}>}
 */
export async function readSource(repoDir = REPO_DIR) {
  try {
    const [branch, sha, status] = await Promise.all([
      run('git', ['-C', repoDir, 'rev-parse', '--abbrev-ref', 'HEAD']),
      run('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD']),
      run('git', ['-C', repoDir, 'status', '--porcelain']),
    ]);
    return {
      ok: true,
      branch: branch.stdout.trim(),
      sha: sha.stdout.trim(),
      dirty: status.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
      branches: SOURCE_BRANCHES.map((entry) => ({ ...entry })),
    };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/**
 * Move the checkout to one of `SOURCE_BRANCHES`.
 *
 * @param {string} branch
 * @param {string} [repoDir]
 * @returns {Promise<{ok: true, changed: boolean, branch: string, sha: string,
 *   restartRequired: boolean}
 *   | {ok: false, reason: string, dirty?: string[]}>}
 */
export async function switchSource(branch, repoDir = REPO_DIR) {
  if (!SOURCE_BRANCHES.some((entry) => entry.name === branch)) {
    return { ok: false, reason: `unknown-branch: ${branch}` };
  }

  const current = await readSource(repoDir);
  if (!current.ok) return current;
  if (current.dirty.length > 0) {
    return { ok: false, reason: 'working tree has uncommitted changes', dirty: current.dirty };
  }

  // Always fetch first: "switch to dev" has to mean "run dev as it is now", not
  // "run whatever dev was when this clone last fetched". A failed fetch (offline,
  // or a clone with no remote) is not fatal -- it degrades to the branch as it
  // already stands, and the result says so.
  const fetched = await run('git', ['-C', repoDir, 'fetch', '--quiet', 'origin', branch])
    .then(() => true)
    .catch(() => false);

  if (current.branch === branch) {
    // Already on it: the useful action is advancing, not switching.
    if (!fetched) {
      return { ok: true, changed: false, branch, sha: current.sha, fresh: false, restartRequired: false };
    }
    try {
      await run('git', ['-C', repoDir, 'merge', '--ff-only', `origin/${branch}`]);
    } catch (error) {
      return { ok: false, reason: `cannot fast-forward ${branch}: ${error?.message ?? error}` };
    }
    const advanced = await readSource(repoDir);
    const sha = advanced.ok ? advanced.sha : current.sha;
    const changed = sha !== current.sha;
    return { ok: true, changed, branch, sha, fresh: true, restartRequired: changed };
  }

  // With a fresh remote tip, `-C` also resets a stale local branch to it; without
  // one, switch the branch exactly as it stands.
  const switchArgs = fetched ? ['-C', branch, `origin/${branch}`] : [branch];
  try {
    await run('git', ['-C', repoDir, 'switch', ...switchArgs]);
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }

  const after = await readSource(repoDir);
  return {
    ok: true,
    changed: true,
    branch,
    sha: after.ok ? after.sha : '?',
    fresh: fetched,
    restartRequired: true,
  };
}

/** One human-readable block for the `/lcm source` command. */
export function renderSource(source) {
  if (!source.ok) return `Source: not a git checkout (${source.reason})`;
  const dirty = source.dirty.length > 0 ? `, ${source.dirty.length} uncommitted` : '';
  const lines = [
    `Source: ${source.branch} @ ${source.sha}${dirty}`,
    ...source.branches.map((entry) => `  ${entry.name === source.branch ? '*' : ' '} ${entry.name.padEnd(8)} ${entry.summary}`),
  ];
  if (source.dirty.length > 0) {
    lines.push('', 'Uncommitted:', ...source.dirty.map((line) => `  ${line}`));
  }
  return lines.join('\n');
}

/** One human-readable line for a switch attempt. */
export function renderSwitch(result) {
  if (!result.ok) {
    const dirty = Array.isArray(result.dirty) && result.dirty.length > 0 ? `\nUncommitted:\n${result.dirty.map((line) => `  ${line}`).join('\n')}` : '';
    return `Switch refused: ${result.reason}${dirty}`;
  }
  const stale = result.fresh === false ? ' (origin unreachable, so this is the local branch)' : '';
  if (!result.changed) return `Already on ${result.branch} @ ${result.sha}${stale}.`;
  return `Switched to ${result.branch} @ ${result.sha}${stale}. Restart DSH for it to take effect.`;
}
