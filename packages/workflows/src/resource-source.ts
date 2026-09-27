/**
 * Resolve a node's command or script reference to the FILE a run would read, path included.
 *
 * The runtime resolver (`loadCommandPrompt` in executor-shared) and the include scan
 * (`resolveCommandContentForScan` in workflow-discovery) both answer "what text does this
 * node get"; neither says WHERE that text lives, and a reader who cannot see the path
 * cannot tell an overridden command from the one they meant to edit. This module answers
 * both, for the console's read-only view of what a node runs.
 *
 * It walks the scopes itself rather than calling either of those: both return content
 * alone, and threading a path out of them would change a code path every run depends on
 * for the sake of a display. The walk uses the SAME helpers the runtime does
 * (`packagedWorkflowDirectory`, `getCommandFolderSearchPaths`, `bundledDefaultCommandPath`,
 * `discoverScriptsForCwd`), and `resource-source.test.ts` pins the precedence — so a
 * divergence fails there rather than in front of someone reading the wrong file.
 */
import { join } from 'path';
import { readFile } from 'fs/promises';
import * as archonPaths from '@archon/paths';
import { isValidCommandName } from './command-validation';
import { BUNDLED_COMMANDS, isBinaryBuild } from './defaults/bundled-defaults';
import { bundledDefaultCommandPath, bundlesPackagedResources } from './defaults/bundle-inventory';
import {
  parsePackagedResourceReference,
  type PackagedResourceReference,
} from './packaged-workflow';
import { discoverScriptsForCwd, type ScriptRuntime } from './script-discovery';
import type { WorkflowSource } from './schemas';
import {
  packagedWorkflowDirectory,
  workflowSourceConfigForRoots,
  type WorkflowSourceRoots,
} from './workflow-source';

/** Where a resolved resource file came from, and what is in it. */
export interface ResolvedResourceFile {
  /**
   * Absolute path of the file. `null` only for a command a compiled binary carries
   * embedded, which has no path on disk at all.
   */
  path: string | null;
  /** The scope that won resolution. Precedence for a bare name: project > global > bundled. */
  scope: WorkflowSource;
  content: string;
}

/** A resolved script file. Its runtime rides along: the node's behaviour depends on it. */
export interface ResolvedScriptFile extends ResolvedResourceFile {
  runtime: ScriptRuntime;
}

/** Settings that decide what the scopes mean — the same two the runtime resolver takes. */
export interface CommandSourceConfig {
  commandFolder?: string;
  loadDefaultCommands?: boolean;
}

/**
 * The settings a set of roots already carries.
 *
 * The roots and the settings are one decision — which command folder counts, and whether
 * the bundled scope counts at all — so the default reads them off the roots instead of
 * asking every caller to pass the pair correctly.
 */
export function commandSourceConfigForRoots(roots: WorkflowSourceRoots): CommandSourceConfig {
  const config = workflowSourceConfigForRoots(roots);
  return {
    ...(config.command_folder !== undefined ? { commandFolder: config.command_folder } : {}),
    ...(config.load_default_commands !== undefined
      ? { loadDefaultCommands: config.load_default_commands }
      : {}),
  };
}

/**
 * A compiled binary's bundled commands live as embedded constants, keyed by the reference
 * exactly as authored — which is how the runtime reads them too. A captured run reads the
 * bytes it froze to disk instead, so this answers for live roots only.
 */
function embeddedBundledCommand(
  roots: WorkflowSourceRoots,
  reference: string
): ResolvedResourceFile | null {
  if (!isBinaryBuild() || roots.kind !== 'live') return null;
  const content = BUNDLED_COMMANDS[reference];
  return content === undefined ? null : { path: null, scope: 'bundled', content };
}

/** Read a candidate path, or null when it is simply not there. */
async function fileAt(path: string, scope: WorkflowSource): Promise<ResolvedResourceFile | null> {
  try {
    return { path, scope, content: await readFile(path, 'utf-8') };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw new Error(`Cannot read resource file ${path}: ${err.message}`, { cause: err });
  }
}

/** First `.md` in `dir` (one subfolder deep) whose basename matches, or null. */
async function findInDir(dir: string, commandName: string): Promise<string | null> {
  let entries: Awaited<ReturnType<typeof archonPaths.findCommandFiles>>;
  try {
    entries = await archonPaths.findCommandFiles(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const match = entries.find(e => e.commandName === commandName);
  return match === undefined ? null : join(dir, match.relativePath);
}

/**
 * A packaged reference names its own owner, so exactly one file can satisfy it: the
 * `commands/<name>.md` inside that pack's workflow directory, under that scope's root.
 */
async function resolvePackagedCommand(
  roots: WorkflowSourceRoots,
  reference: string,
  packaged: PackagedResourceReference,
  config: CommandSourceConfig
): Promise<ResolvedResourceFile | null> {
  const { owner, name } = packaged;
  if (owner.source === 'bundled') {
    if (config.loadDefaultCommands === false) return null;
    if (
      roots.kind === 'live' &&
      !isBinaryBuild() &&
      !(await bundlesPackagedResources(owner.pack))
    ) {
      return null;
    }
    const embedded = embeddedBundledCommand(roots, reference);
    if (embedded !== null) return embedded;
  }
  const workflowDir = await packagedWorkflowDirectory(roots, owner);
  if (workflowDir === null) return null;
  return fileAt(join(workflowDir, 'commands', `${name}.md`), owner.source);
}

/**
 * Resolve a command reference — bare name or packaged reference — to its file.
 *
 * Precedence for a bare name mirrors the runtime: the repo's command folders (one subfolder
 * deep), then `~/.archon/commands/`, then the bundled defaults, which a repo may switch
 * off. Returns `null` when nothing resolves, which is what the console shows as "this node
 * points at a command that is not there".
 */
export async function resolveCommandFile(
  roots: WorkflowSourceRoots,
  commandName: string,
  config: CommandSourceConfig = commandSourceConfigForRoots(roots)
): Promise<ResolvedResourceFile | null> {
  const packaged = parsePackagedResourceReference(commandName);
  if (packaged !== null) return resolvePackagedCommand(roots, commandName, packaged, config);
  if (!isValidCommandName(commandName)) return null;

  const projectRoot = roots.project;
  if (projectRoot !== null) {
    for (const folder of archonPaths.getCommandFolderSearchPaths(config.commandFolder)) {
      const path = await findInDir(join(projectRoot, folder), commandName);
      const resolved = path === null ? null : await fileAt(path, 'project');
      if (resolved !== null) return resolved;
    }
  }

  const globalPath = await findInDir(roots.globalCommands, commandName);
  const inGlobal = globalPath === null ? null : await fileAt(globalPath, 'global');
  if (inGlobal !== null) return inGlobal;

  if (config.loadDefaultCommands === false) return null;
  const embedded = embeddedBundledCommand(roots, commandName);
  if (embedded !== null) return embedded;
  // Live defaults are the flat selection the bundle index ships, so they resolve by direct
  // path; a capture keeps whatever layout it froze, subfolders included.
  const bundledPath =
    roots.kind === 'captured'
      ? await findInDir(roots.bundledCommands, commandName)
      : await bundledDefaultCommandPath(roots.bundledCommands, commandName);
  return bundledPath === null ? null : fileAt(bundledPath, 'bundled');
}

/**
 * Which scope a script path belongs to, for display only.
 *
 * Script discovery returns paths, not scopes, and a packaged reference already names its
 * owner — so the owner is read from the reference when there is one, and otherwise inferred
 * from which root the path sits under. A bare name resolving outside every known root reads
 * as `bundled`, which is where discovery materializes its own.
 */
function scriptScope(roots: WorkflowSourceRoots, reference: string, path: string): WorkflowSource {
  const packaged = parsePackagedResourceReference(reference);
  if (packaged !== null) return packaged.owner.source;
  if (roots.project !== null && path.startsWith(join(roots.project, '.archon'))) return 'project';
  if (path.startsWith(roots.globalScripts) || path.startsWith(roots.globalWorkflows)) {
    return 'global';
  }
  return 'bundled';
}

/**
 * Resolve a `script:` reference to the file a run would execute.
 *
 * Unlike commands, scripts are already discovered as paths — `discoverScriptsForCwd` walks
 * the same scopes the runtime does and returns `{ path, runtime }` — so this reads that map
 * rather than re-walking anything. An inline `script:` body (a snippet, not a name) is not a
 * file and resolves to `null`; a caller holding the body needs nothing from here.
 */
export async function resolveScriptFile(
  roots: WorkflowSourceRoots,
  reference: string,
  cwd: string | null
): Promise<ResolvedScriptFile | null> {
  const scripts = await discoverScriptsForCwd(cwd ?? roots.project ?? '', roots);
  const found = scripts.get(reference);
  if (found === undefined) return null;
  const file = await fileAt(found.path, scriptScope(roots, reference, found.path));
  return file === null ? null : { ...file, runtime: found.runtime };
}
