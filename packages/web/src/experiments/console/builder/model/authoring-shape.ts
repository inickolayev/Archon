/**
 * Turn a node the SERVER sent back into the authoring shape the builder edits.
 *
 * The engine's Zod schema does not merely validate a node, it rewrites it: `command:` becomes
 * `kind: 'agent'` + `source: { kind: 'command', name }`, `prompt:` becomes an `inline` source,
 * `bash:` becomes `kind: 'exec'` with `runtime: 'sh'`, and an approval becomes a `gate` with
 * its decisions expanded. `GET /api/workflows` serves that rewritten form, while the OpenAPI
 * schema — generated from the input side of the same transform, and therefore the type in
 * `api.generated.d.ts` — describes what an author WRITES. The builder was built against the
 * type, so every agent node arrived with no mode field at all and opened as an empty prompt
 * node: a command node showed neither its command nor, therefore, the file behind it.
 *
 * This module is the one place that knows both forms. It maps back, field by field, so the
 * importer, the inspector, the validation panel and the YAML preview all see what the author
 * wrote. Nodes the builder has no variant for (include, workflow, loop_group, composed
 * fan-out) are handed on unchanged and still surface as import issues — silence about them
 * would be worse than the honest "cannot determine the node variant".
 */
import type { WireDagNode } from '../types';

/** The `source` of an agent node, as the transform emits it. */
type AgentSource =
  | { kind: 'command'; name: string; with?: unknown }
  | { kind: 'inline'; prompt: string };

/** One decision of a gate node, as the transform emits it. */
interface GateDecision {
  id: string;
  rework?: { prompt: string; maxAttempts?: number };
}

/**
 * The transform's output fields, which the generated (authoring-side) type omits. Optional
 * throughout: a node that already is in authoring shape — a builder draft on its way to a
 * save, a fixture — carries none of them.
 */
interface TransformedFields {
  kind?: string;
  source?: AgentSource;
  script?: string;
  runtime?: string;
  reason?: string;
  message?: string;
  decisions?: GateDecision[];
  decisionsAuthored?: boolean;
  captureResponse?: boolean;
}

/**
 * `script` and `runtime` are re-declared rather than intersected: the authoring type narrows
 * `runtime` to the two script runtimes, while the transform also emits `'sh'` for a bash node —
 * and an intersection would make that value unrepresentable, so the check for it would not
 * even compile.
 */
type ServedNode = Omit<WireDagNode, 'script' | 'runtime'> & TransformedFields;

/**
 * The kind of a node the builder has no variant for — a composition shape: `include:`, a
 * `workflow:` child, a loop group, a composed fan-out. `null` for everything the builder can
 * edit, including a node that is already in authoring shape.
 *
 * Callers use this to say WHICH shape they are looking at. "Cannot determine the node variant"
 * is true but useless when the node plainly says it composes another workflow.
 */
export function composedNodeKind(node: WireDagNode): string | null {
  const kind = (node as ServedNode).kind;
  if (kind === undefined) return null;
  return modeFields(node as ServedNode) === null ? kind : null;
}

/**
 * Fields the transform ADDS, which no authoring node carries.
 *
 * `script` and `runtime` are in the list even though an author writes them: for a bash node
 * the transform moves the body into `script` and sets `runtime: 'sh'`, so carrying them
 * through would leave a bash node claiming to be a script. `modeFields` puts back whichever
 * of the two the node actually had.
 */
const ADDED_BY_TRANSFORM = new Set([
  'kind',
  'source',
  'reason',
  'message',
  'decisions',
  'decisionsAuthored',
  'captureResponse',
  'script',
  'runtime',
]);

/** Copy `value` under `key` only when it is set, keeping nodes sparse. */
function present<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/** `approval:` as written, rebuilt from the gate the transform produced. */
function approvalFromGate(node: ServedNode): Record<string, unknown> {
  const decisions = node.decisions ?? [];
  // `decisionsAuthored` records whether the author listed decisions or the transform
  // synthesized them — the one bit that tells the two mechanisms apart.
  const authored = node.decisionsAuthored === true ? { decisions } : {};
  const rework = decisions.find(d => d.rework !== undefined)?.rework;
  const onReject =
    node.decisionsAuthored !== true && rework !== undefined
      ? {
          on_reject: {
            prompt: rework.prompt,
            ...present('max_attempts', rework.maxAttempts),
          },
        }
      : {};
  return {
    approval: {
      ...present('message', node.message),
      ...(node.captureResponse === true ? { capture_response: true } : {}),
      ...authored,
      ...onReject,
    },
  };
}

/** The mode fields for one served node, or `null` when its kind has no builder variant. */
function modeFields(node: ServedNode): Record<string, unknown> | null {
  switch (node.kind) {
    case 'agent': {
      const source = node.source;
      if (source === undefined) return null;
      return source.kind === 'command'
        ? { command: source.name, ...present('with', source.with) }
        : { prompt: source.prompt };
    }
    case 'exec': {
      const script = node.script;
      if (script === undefined) return null;
      // A bash node is an exec node with the shell as its runtime; anything else is a
      // named (or inline) script whose runtime the author chose.
      return node.runtime === 'sh'
        ? { bash: script }
        : { script, ...present('runtime', node.runtime) };
    }
    case 'gate':
      return approvalFromGate(node);
    case 'halt':
      return { ...present('cancel', node.reason) };
    // These two already carry the field their author wrote (`wait:` / `loop:`), so only the
    // added `kind` has to go.
    case 'wait':
    case 'loop':
      return {};
    default:
      // A shape the builder has no variant for (include, workflow, loop_group, composed
      // fan-out). Handed on as it arrived, so the importer reports it rather than the
      // builder quietly editing a node it does not understand.
      return null;
  }
}

/**
 * The authoring form of a served node: its own fields, minus the ones the transform added,
 * plus the mode field the author wrote.
 *
 * A node that is already in authoring shape passes through unchanged, so this is safe to
 * apply on every import path regardless of where the definition came from.
 */
export function toAuthoringNode(node: WireDagNode): WireDagNode {
  const served = node as ServedNode;
  if (served.kind === undefined) return node;
  const fields = modeFields(served);
  if (fields === null) return node;

  const carried = Object.entries(served).filter(([key]) => !ADDED_BY_TRANSFORM.has(key));
  return { ...Object.fromEntries(carried), ...fields } as WireDagNode;
}
