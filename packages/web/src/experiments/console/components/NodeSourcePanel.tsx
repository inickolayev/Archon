import { useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import * as skill from '../skills';
import { HttpError } from '../lib/http';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import { describeResourceRef, packLabel } from '../primitives/resource-ref';

interface NodeSourcePanelProps {
  workflowName: string;
  nodeId: string;
  /** The project the workflow was read in; the server resolves the file relative to it. */
  cwd?: string;
  /**
   * A caveat to show under the path. The run view passes one: everything here is read from the
   * workflow as it stands now, so a run from last week may have been given another version —
   * of the file, and of an inlined prompt just as much.
   */
  note?: string;
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

/** What each shape is called on the panel, in the reader's terms rather than the schema's. */
const LABELS: Record<string, string> = {
  command: 'Prompt file',
  script: 'Script file',
  prompt: 'Prompt',
  bash: 'Shell',
};

/**
 * The file one node runs, read-only: a command node's markdown prompt or a script node's
 * source, with the path it was read from and the scope that won resolution.
 *
 * This is the only place in the console where the text an agent is actually given can be read.
 * Two things are deliberate. The path is shown in full, because "which of the three same-named
 * files is this" is the question a reader has. And a markdown prompt can be switched to raw:
 * rendered is easier to read, but what the agent receives is the bytes, and a prompt is edited
 * as bytes — so both have to be available.
 *
 * Markdown is NOT rendered through `MessageMarkdown`: that map resolves local image paths
 * against a chat conversation, which a command file has nothing to do with.
 */
/**
 * What the panel has to say before it has a file.
 *
 * `undefined` data is always "reading", never "nothing here": the panel starts its own request
 * the moment it mounts, and the store reports `loading` only once that request is in flight —
 * so keying the text on `loading` showed "no file" for the first paint of every panel.
 *
 * An error is an answer rather than a failure. A 404 is how the server says this node runs no
 * command or script, or that the file it names is not there; its own message is the most
 * specific thing anyone can say, so it is shown verbatim.
 */
export function pendingMessage(error: Error | undefined): string {
  if (error === undefined) return 'Reading…';
  return error instanceof HttpError ? (error.serverError ?? error.bodySnippet) : error.message;
}

export function NodeSourcePanel({
  workflowName,
  nodeId,
  cwd,
  note,
}: NodeSourcePanelProps): ReactElement {
  const [raw, setRaw] = useState(false);
  const { data, error } = useEntity(K.nodeSource(cwd ?? '', workflowName, nodeId), () =>
    skill.getNodeSource(workflowName, nodeId, cwd)
  );

  if (data === undefined) {
    return (
      <Frame label="File">
        <p className="font-mono text-[11.5px] text-text-tertiary">{pendingMessage(error)}</p>
      </Frame>
    );
  }

  const ref = data.name === undefined ? null : describeResourceRef(data.name);
  // A command file is markdown, and so is the text of an inline prompt — including the one
  // include expansion compiled out of a command file, which is the form a composed workflow's
  // node arrives in. A script and a shell body are code and stay verbatim.
  const isMarkdown = data.kind === 'command' || data.kind === 'prompt';
  const showRendered = isMarkdown && !raw;

  return (
    <Frame
      label={LABELS[data.kind]}
      action={
        isMarkdown ? (
          <button
            type="button"
            onClick={() => {
              setRaw(v => !v);
            }}
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-text-tertiary transition-colors hover:text-text-primary"
          >
            {raw ? 'rendered' : 'raw'}
          </button>
        ) : null
      }
    >
      <div className="flex flex-col gap-1">
        {ref === null ? null : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="font-mono text-[12px] text-text-primary">{ref.name}</span>
            {ref.owner !== null ? (
              <span className="font-mono text-[10px] text-text-tertiary">
                pack {packLabel(ref.owner)}
              </span>
            ) : null}
            {data.scope === undefined ? null : (
              <span className="font-mono text-[10px] text-text-tertiary">{data.scope}</span>
            )}
            {data.runtime === undefined ? null : (
              <span className="font-mono text-[10px] text-text-tertiary">{data.runtime}</span>
            )}
          </div>
        )}
        {data.path !== null ? (
          <p title={data.path} className="break-all font-mono text-[10px] text-text-tertiary">
            {data.path}
          </p>
        ) : ref !== null ? (
          <p className="font-mono text-[10px] text-text-tertiary">
            embedded in this build — no file on disk
          </p>
        ) : (
          <p className="font-mono text-[10px] text-text-tertiary">
            written into the workflow itself, not read from a file
          </p>
        )}
        {note === undefined ? null : (
          <p className="font-mono text-[10px] text-text-tertiary">{note}</p>
        )}
      </div>
      <div
        className="mt-2 max-h-[420px] overflow-y-auto rounded-[8px] border bg-surface-inset p-2"
        style={{ borderColor: 'var(--border)' }}
      >
        {showRendered ? (
          <div className="chat-markdown text-[12.5px] leading-relaxed text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {data.content}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-primary">
            {data.content}
          </pre>
        )}
      </div>
    </Frame>
  );
}

/** The section shell, so every state above looks like one section of the inspector. */
function Frame({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactElement | null;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-text-tertiary">
          {label}
        </span>
        {action}
      </div>
      {children}
    </section>
  );
}
