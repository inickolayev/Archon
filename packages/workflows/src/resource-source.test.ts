import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { getDefaultWorkflowsPath } from '@archon/paths';
import { removeTempTree } from '@archon/paths/test-utils';
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveCommandFile, resolveScriptFile } from './resource-source';
import { formatPackagedResourceReference } from './packaged-workflow';
import type { LiveWorkflowSourceRoots } from './workflow-source';

const tempDirectories: string[] = [];

afterEach(async () => {
  for (const directory of tempDirectories.splice(0)) await removeTempTree(directory);
});

/**
 * One temp tree standing in for all three scopes, wired into roots by hand.
 *
 * `liveSourceRoots` would read the real `ARCHON_HOME`, and these tests are about which
 * scope wins — so the scopes have to be ours, not the machine's.
 */
async function scopes(): Promise<{
  root: string;
  project: string;
  home: string;
  bundled: string;
  roots: LiveWorkflowSourceRoots;
}> {
  const root = await mkdtemp(join(tmpdir(), 'archon-resource-source-'));
  tempDirectories.push(root);
  const project = join(root, 'project');
  const home = join(root, 'home');
  const bundled = join(root, 'bundled');
  await Promise.all([
    mkdir(join(project, '.archon', 'commands'), { recursive: true }),
    mkdir(join(home, 'commands'), { recursive: true }),
    mkdir(join(bundled, 'defaults'), { recursive: true }),
  ]);
  return {
    root,
    project,
    home,
    bundled,
    roots: {
      kind: 'live',
      project,
      globalWorkflows: join(home, 'workflows'),
      globalCommands: join(home, 'commands'),
      globalScripts: join(home, 'scripts'),
      bundledWorkflows: bundled,
      bundledCommands: join(bundled, 'defaults'),
      installed: { kind: 'receipts', pluginsDir: join(home, 'plugins') },
      config: { load_default_workflows: true, load_default_commands: true },
    },
  };
}

describe('resolveCommandFile', () => {
  test('reads a repo command and says where it read it', async () => {
    const { project, roots } = await scopes();
    const path = join(project, '.archon', 'commands', 'greet.md');
    await writeFile(path, '# Greet\n');

    expect(await resolveCommandFile(roots, 'greet')).toEqual({
      path,
      scope: 'project',
      content: '# Greet\n',
    });
  });

  test('a repo command wins over the same name in home and bundled', async () => {
    const { project, home, bundled, roots } = await scopes();
    await writeFile(join(project, '.archon', 'commands', 'greet.md'), 'repo\n');
    await writeFile(join(home, 'commands', 'greet.md'), 'home\n');
    await writeFile(join(bundled, 'defaults', 'greet.md'), 'bundled\n');

    expect((await resolveCommandFile(roots, 'greet'))?.content).toBe('repo\n');
  });

  test('home wins over bundled when the repo has nothing', async () => {
    const { home, bundled, roots } = await scopes();
    await writeFile(join(home, 'commands', 'greet.md'), 'home\n');
    await writeFile(join(bundled, 'defaults', 'greet.md'), 'bundled\n');

    expect(await resolveCommandFile(roots, 'greet')).toEqual({
      path: join(home, 'commands', 'greet.md'),
      scope: 'global',
      content: 'home\n',
    });
  });

  test('a repo command one subfolder deep resolves by its basename', async () => {
    const { project, roots } = await scopes();
    await mkdir(join(project, '.archon', 'commands', 'triage'), { recursive: true });
    await writeFile(join(project, '.archon', 'commands', 'triage', 'review.md'), 'nested\n');

    expect((await resolveCommandFile(roots, 'review'))?.content).toBe('nested\n');
  });

  test('the bundled scope is skipped when the repo switched defaults off', async () => {
    const { bundled, roots } = await scopes();
    await writeFile(join(bundled, 'defaults', 'greet.md'), 'bundled\n');

    expect(await resolveCommandFile(roots, 'greet', { loadDefaultCommands: false })).toBeNull();
  });

  test("a configured command folder is searched, since that is where the repo's commands are", async () => {
    const { project, roots } = await scopes();
    await mkdir(join(project, 'prompts'), { recursive: true });
    await writeFile(join(project, 'prompts', 'greet.md'), 'configured\n');

    expect((await resolveCommandFile(roots, 'greet', { commandFolder: 'prompts' }))?.content).toBe(
      'configured\n'
    );
  });

  test('bundled defaults answer when neither the repo nor home has the name', async () => {
    const { bundled, roots } = await scopes();
    await writeFile(join(bundled, 'defaults', 'greet.md'), 'bundled\n');

    expect(await resolveCommandFile(roots, 'greet')).toEqual({
      path: join(bundled, 'defaults', 'greet.md'),
      scope: 'bundled',
      content: 'bundled\n',
    });
  });

  test('a packaged reference resolves inside its own pack, under its own scope', async () => {
    const { home, roots } = await scopes();
    const owner = { source: 'global', pack: 'chesswin', workflow: 'announce' } as const;
    const dir = join(home, 'workflows', 'chesswin', 'announce', 'commands');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'announce.md'), 'packaged\n');
    // A same-named bare command in the repo must NOT win: the reference names its owner.
    await writeFile(join(roots.project ?? '', '.archon', 'commands', 'announce.md'), 'repo\n');

    const reference = formatPackagedResourceReference(owner, 'announce');
    expect(await resolveCommandFile(roots, reference)).toEqual({
      path: join(dir, 'announce.md'),
      scope: 'global',
      content: 'packaged\n',
    });
  });

  test('a reference to a missing file resolves to nothing rather than throwing', async () => {
    const { roots } = await scopes();
    expect(await resolveCommandFile(roots, 'nobody-wrote-this')).toBeNull();
  });

  test('a name that tries to climb out of its folder resolves to nothing', async () => {
    const { roots } = await scopes();
    expect(await resolveCommandFile(roots, '../secrets')).toBeNull();
  });
});

/**
 * Script discovery walks the bundled packs the build's own index declares, so the bundled
 * root has to be the real one — an empty stand-in makes discovery refuse to run at all.
 * Command precedence stays on the temp tree above; only these tests need the real tree.
 */
function withRealBundledWorkflows(roots: LiveWorkflowSourceRoots): LiveWorkflowSourceRoots {
  return { ...roots, bundledWorkflows: dirname(getDefaultWorkflowsPath()) };
}

describe('resolveScriptFile', () => {
  test('reads a packaged script and reports its runtime', async () => {
    const { home, roots } = await scopes();
    const owner = { source: 'global', pack: 'chesswin', workflow: 'announce' } as const;
    const dir = join(home, 'workflows', 'chesswin', 'announce', 'scripts');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'deliver.py'), 'print("sent")\n');

    const reference = formatPackagedResourceReference(owner, 'deliver');
    expect(
      await resolveScriptFile(withRealBundledWorkflows(roots), reference, roots.project)
    ).toEqual({
      path: join(dir, 'deliver.py'),
      scope: 'global',
      runtime: 'uv',
      content: 'print("sent")\n',
    });
  });

  test('reads a repo script by bare name', async () => {
    const { project, roots } = await scopes();
    await mkdir(join(project, '.archon', 'scripts'), { recursive: true });
    await writeFile(join(project, '.archon', 'scripts', 'tally.ts'), 'export {};\n');

    expect(await resolveScriptFile(withRealBundledWorkflows(roots), 'tally', project)).toEqual({
      path: join(project, '.archon', 'scripts', 'tally.ts'),
      scope: 'project',
      runtime: 'bun',
      content: 'export {};\n',
    });
  });

  test('an inline script body is not a file and resolves to nothing', async () => {
    const { project, roots } = await scopes();
    expect(
      await resolveScriptFile(withRealBundledWorkflows(roots), 'echo "not a name"\n', project)
    ).toBeNull();
  });
});
