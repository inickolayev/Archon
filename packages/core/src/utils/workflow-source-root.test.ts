import { afterAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CanonicalRepoPathUnavailableError, getCanonicalRepoPath } from '@archon/git';
import { resolveWorkflowSourceRoot } from './workflow-source-root';

/**
 * Real Git layouts, not mocks: what this function must answer depends on what Git itself
 * reports about a checkout, and a mock of Git would just restate the assumption under test.
 *
 * The layout that matters here is a BARE repository owning linked worktrees — one object
 * store, one checkout per task, no primary checkout anywhere. A server that clones once with
 * `--bare` and runs `git worktree add` per job has exactly this, and before the bare case was
 * recognised such a server could not start a single run: resolution threw, and the caller
 * treats "unknown authoring source" as a reason to refuse.
 */
const exec = promisify(execFile);

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** `git init` plus one commit — a repository with a working tree of its own. */
async function createCheckout(path: string): Promise<void> {
  await exec('git', ['init', '--initial-branch=main', path]);
  await exec('git', ['-C', path, 'config', 'user.email', 'test@example.com']);
  await exec('git', ['-C', path, 'config', 'user.name', 'Test']);
  await writeFile(join(path, 'README.md'), '# test\n', 'utf8');
  await exec('git', ['-C', path, 'add', 'README.md']);
  await exec('git', ['-C', path, 'commit', '-m', 'init']);
}

describe('resolveWorkflowSourceRoot', () => {
  test('an ordinary checkout is its own authoring root', async () => {
    const root = await tempRoot('archon-source-root-plain-');
    const checkout = join(root, 'repo');
    await createCheckout(checkout);

    expect(await resolveWorkflowSourceRoot(checkout)).toBeUndefined();
  });

  test('a worktree of an ordinary checkout authors from that checkout', async () => {
    const root = await tempRoot('archon-source-root-linked-');
    const checkout = join(root, 'repo');
    const worktree = join(root, 'wt');
    await createCheckout(checkout);
    await exec('git', ['-C', checkout, 'worktree', 'add', '-b', 'task', worktree]);

    expect(await resolveWorkflowSourceRoot(worktree)).toBe(checkout);
  });

  test('a worktree of a BARE repository is its own authoring root', async () => {
    const root = await tempRoot('archon-source-root-bare-');
    const seed = join(root, 'seed');
    const bare = join(root, 'repo.git');
    const worktree = join(root, 'wt');
    await createCheckout(seed);
    await exec('git', ['clone', '--bare', seed, bare]);
    await exec('git', ['-C', bare, 'worktree', 'add', '-b', 'task', worktree]);

    // Git's own answer stays "there is no primary checkout" — codebase resolution relies on
    // that error to fall back to matching the common Git directory, so it must not change.
    await expect(getCanonicalRepoPath(worktree)).rejects.toBeInstanceOf(
      CanonicalRepoPathUnavailableError
    );

    // The run, however, starts: no canonical checkout exists, so the worktree is the root.
    expect(await resolveWorkflowSourceRoot(worktree)).toBeUndefined();
  });

  test('an unresolvable non-bare layout still refuses to guess', async () => {
    const root = await tempRoot('archon-source-root-separate-');
    const checkout = join(root, 'repo');
    const external = join(root, 'external.git');
    const worktree = join(root, 'wt');
    await createCheckout(checkout);
    // `--separate-git-dir` moves the repository out of the checkout. The external directory
    // keeps no reverse pointer to it, so a worktree of this repository has an authoring root
    // that exists but cannot be named — the case that must keep throwing.
    await exec('git', ['-C', checkout, 'init', '--separate-git-dir', external]);
    await exec('git', ['-C', checkout, 'worktree', 'add', '-b', 'task', worktree]);

    await expect(resolveWorkflowSourceRoot(worktree)).rejects.toThrow(
      /authoring\s+source is unknown/
    );
  });
});
