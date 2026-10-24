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
  Object.freeze({ name: 'main', summary: 'Released code only. The safest.' }),
  Object.freeze({ name: 'dev', summary: 'Daily work. Tested, but it moves.' }),
  Object.freeze({ name: 'polaris', summary: 'New features and breaking changes. May break.' }),
]);

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
  if (current.branch === branch) {
    return { ok: true, changed: false, branch, sha: current.sha, restartRequired: false };
  }
  if (current.dirty.length > 0) {
    return { ok: false, reason: 'working tree has uncommitted changes', dirty: current.dirty };
  }

  try {
    await run('git', ['-C', repoDir, 'switch', branch]);
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }

  const after = await readSource(repoDir);
  return {
    ok: true,
    changed: true,
    branch,
    sha: after.ok ? after.sha : '?',
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
  if (!result.changed) return `Already on ${result.branch} @ ${result.sha}.`;
  return `Switched to ${result.branch} @ ${result.sha}. Restart DSH for it to take effect.`;
}
