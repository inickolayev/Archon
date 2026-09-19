import { useEffect, useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import rehypeHighlight from 'rehype-highlight';
import * as skill from '../skills';
import {
  artifactBasename,
  artifactKind,
  artifactUrl,
  formatArtifactSize,
} from '../primitives/artifact';
import type { ArtifactFile } from '../skills/runs';

interface ArtifactViewerProps {
  runId: string;
  file: ArtifactFile;
  /** Open this file in the full-screen image viewer (images only). */
  onOpenImage: (path: string) => void;
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

/**
 * The right-hand pane of the artifact browser: one file, rendered by kind.
 * Markdown and text are fetched as text; an image is rendered straight from
 * the raw URL (no text request at all — that is what turned screenshots into
 * a wall of mangled characters); a PDF is embedded; anything else is offered
 * as a download instead of being dumped into the page.
 */
export function ArtifactViewer({ runId, file, onOpenImage }: ArtifactViewerProps): ReactElement {
  const path = file.path;
  const kind = artifactKind(path);
  const url = artifactUrl(runId, path);
  const isDocument = kind === 'markdown' || kind === 'text';

  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isDocument) {
      setContent(null);
      setError(null);
      setLoading(false);
      return;
    }
    // Switching files fast must not let a slow earlier response overwrite the
    // newer one.
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    void skill
      .fetchArtifact(runId, path)
      .then(text => {
        if (!cancelled) setContent(text);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load artifact');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [runId, path, isDocument]);

  return (
    <>
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface px-6 py-2">
        <span className="truncate font-mono text-[12px] text-text-primary">{path}</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-mono text-[10px] text-text-tertiary transition-colors hover:text-text-primary"
        >
          open raw ↗
        </a>
      </header>
      <div className={`min-h-0 flex-1 overflow-y-auto px-6 py-4 ${kind === 'pdf' ? 'flex' : ''}`}>
        {kind === 'image' ? (
          <ArtifactImage
            url={url}
            name={artifactBasename(path)}
            onOpen={() => {
              onOpenImage(path);
            }}
          />
        ) : kind === 'pdf' ? (
          <iframe
            src={url}
            title={artifactBasename(path)}
            className="min-h-[520px] w-full flex-1 rounded border border-border bg-surface"
          />
        ) : kind === 'binary' ? (
          <BinaryArtifactCard file={file} url={url} />
        ) : loading ? (
          <p className="font-mono text-[12px] text-text-tertiary">Loading…</p>
        ) : error !== null ? (
          <p className="font-mono text-[12px] text-error">{error}</p>
        ) : content === null ? null : kind === 'markdown' ? (
          <div className="chat-markdown max-w-[820px] text-[13px] leading-relaxed text-text-primary">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <pre className="max-w-[1100px] whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-primary">
            {content}
          </pre>
        )}
      </div>
    </>
  );
}

interface ArtifactImageProps {
  url: string;
  name: string;
  onOpen: () => void;
}

function ArtifactImage({ url, name, onOpen }: ArtifactImageProps): ReactElement {
  const [failed, setFailed] = useState(false);

  // Say what went wrong instead of leaving the browser's broken-image glyph:
  // a screenshot that will not decode is a real signal (truncated write, a
  // file the agent never finished).
  if (failed) {
    return (
      <div className="max-w-[520px] rounded-lg border border-border bg-surface-inset p-4 text-[12px] text-text-secondary">
        <p className="text-error">This image could not be displayed.</p>
        <p className="mt-2 font-mono text-[11px] text-text-tertiary">
          The file may be truncated or not a real image. Try{' '}
          <a href={url} target="_blank" rel="noreferrer" className="underline">
            opening it raw
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open full screen"
      className="block cursor-zoom-in rounded-lg border border-border bg-surface-inset p-2 transition-colors hover:border-[color:var(--brand-magenta)]"
    >
      <img
        src={url}
        alt={name}
        onError={() => {
          setFailed(true);
        }}
        className="max-h-[70vh] max-w-full rounded object-contain"
      />
    </button>
  );
}

interface BinaryArtifactCardProps {
  file: ArtifactFile;
  url: string;
}

function BinaryArtifactCard({ file, url }: BinaryArtifactCardProps): ReactElement {
  return (
    <div className="max-w-[520px] rounded-lg border border-border bg-surface-inset p-4">
      <p className="truncate font-mono text-[13px] text-text-primary">
        {artifactBasename(file.path)}
      </p>
      <p className="mt-1 font-mono text-[11px] text-text-tertiary">
        {formatArtifactSize(file.size)} · binary file — not shown as text
      </p>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center rounded-md border border-border px-3 py-1.5 font-mono text-[11px] text-text-secondary transition-colors hover:border-[color:var(--brand-magenta)] hover:text-text-primary"
      >
        open raw ↗
      </a>
    </div>
  );
}
