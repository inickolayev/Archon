// @archon-test-isolated
/**
 * chesswin: the Factory's own pack lives in the global scope on purpose (chesswin-factory
 * ADR 0008, item 8) and every CLI run of it passes --workflow-source <pinned engine>. Upstream
 * #5854 refuses a global workflow under --workflow-source; the operator re-admits the global
 * scope — and only it — with ARCHON_WORKFLOW_SOURCE_ADMITS_GLOBAL=1 (chesswin-factory#40).
 * Fixture helpers follow upstream's workflow-dry-run-source.integration.spec.ts.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempTree } from '@archon/paths/test-utils';
import { dryRunResultSchema, type DryRunResult } from '@archon/workflows/dry-run';
import { workflowRunCommand } from './workflow-run-owned';
import { captureWorkflowCommand } from '../test-support/command';
import { WORKFLOW_SOURCE_ADMITS_GLOBAL } from './workflow-source-global';

const roots: string[] = [];

afterEach(async () => {
  delete process.env[WORKFLOW_SOURCE_ADMITS_GLOBAL];
  for (const root of roots.splice(0)) await removeTempTree(root);
});

interface Fixture {
  source: string;
  target: string;
  home: string;
}

/** A workflow source and a target that share nothing, as with a pack kept outside the repo. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'archon-dry-run-source-'));
  roots.push(root);
  const fx = {
    source: join(root, 'source'),
    target: join(root, 'target'),
    home: join(root, 'home'),
  };
  for (const dir of Object.values(fx)) mkdirSync(dir, { recursive: true });
  return fx;
}

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

async function dryRun(
  fx: Fixture,
  workflow: string,
  source: string | null = fx.source
): Promise<DryRunResult> {
  // The JSON result goes through process.stdout.write, which captureCommand does not see.
  let json = '';
  const write = spyOn(process.stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    json += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    const done = rest.find(arg => typeof arg === 'function') as (() => void) | undefined;
    done?.();
    return true;
  }) as typeof process.stdout.write);
  let result: Awaited<ReturnType<typeof captureWorkflowCommand>>;
  try {
    result = await captureWorkflowCommand(fx.home, async host => {
      await workflowRunCommand(host, fx.target, workflow, '', {
        ...(source === null ? {} : { discoveryCwd: source }),
        dryRun: true,
        defaultStubs: true,
        json: true,
      });
    });
  } finally {
    write.mockRestore();
  }
  if (!json.trim()) throw new Error(`No dry-run result in output:\n${result.output}`);
  return dryRunResultSchema.parse(JSON.parse(json));
}

function writeGlobalProbe(fx: Fixture): void {
  write(
    join(fx.home, 'workflows', 'probe.yaml'),
    'name: probe\ndescription: global\nnodes:\n  - id: probe\n    bash: echo global\n'
  );
}

// A dry run under source capture takes seconds on a slow runner; bun's 5 s default is too tight.
const SLOW = 60_000;

describe('workflow run --workflow-source with the global scope admitted', () => {
  test(
    'runs a workflow that only the global scope has',
    async () => {
      const fx = fixture();
      writeGlobalProbe(fx);
      process.env[WORKFLOW_SOURCE_ADMITS_GLOBAL] = '1';

      const result = await dryRun(fx, 'probe');

      expect(result.outcome).toBe('completed');
    },
    SLOW
  );

  test(
    'without the flag the same run is still refused',
    async () => {
      const fx = fixture();
      writeGlobalProbe(fx);

      const result = await captureWorkflowCommand(fx.home, async host => {
        await workflowRunCommand(host, fx.target, 'probe', '', {
          discoveryCwd: fx.source,
          dryRun: true,
          defaultStubs: true,
        });
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('global scope');
    },
    SLOW
  );
});
