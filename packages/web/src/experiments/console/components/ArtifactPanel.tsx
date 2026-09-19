import { useEffect, useState, type ReactElement } from 'react';
import { useEntity } from '../store/cache';
import { K } from '../store/keys';
import * as skill from '../skills';
import { HttpError } from '../lib/http';
import {
  artifactBasename,
  artifactKind,
  artifactUrl,
  formatArtifactSize,
} from '../primitives/artifact';
import type { ArtifactFile } from '../skills/runs';
import { ArtifactViewer } from './ArtifactViewer';
import { ImageLightbox, type LightboxImage } from './ImageLightbox';

interface ArtifactPanelProps {
  runId: string;
}

/**
 * Full-width artifact browser: sidebar of files on the left, rendered file
 * on the right. Sourced from `/api/runs/:runId/artifacts` (walks the on-disk
 * artifact dir) rather than `workflow_artifact` events — bash/script nodes
 * typically write straight to $ARTIFACTS_DIR without emitting an event.
 *
 * Rendering is picked per file by `artifactKind` (see ArtifactViewer): a run
 * that wrote 40 screenshots is browsed by thumbnail, and clicking one opens
 * the full-screen viewer, which steps through this run's images in sidebar
 * order.
 */
export function ArtifactPanel({ runId }: ArtifactPanelProps): ReactElement {
  const {
    data: files,
    error: listError,
    loading,
  } = useEntity<ArtifactFile[]>(K.artifacts(runId), () => skill.listRunArtifacts(runId));

  const [selected, setSelected] = useState<string | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  // Auto-select the first file once the list arrives (or when the run changes).
  useEffect(() => {
    if (files !== undefined && files.length > 0 && selected === null) {
      setSelected(files[0].path);
    }
  }, [files, selected]);

  if (loading) {
    return <div className="p-6 text-[12px] text-text-tertiary">Loading artifacts…</div>;
  }
  if (listError !== undefined) {
    // A 404 means the server could not resolve WHERE this run's output lives
    // (or the run is gone) — an error state, deliberately distinct from the
    // empty-list case below, which means "resolved fine, produced nothing".
    // The route used to return an empty 200 for both, making them
    // indistinguishable (#2200).
    if (listError instanceof HttpError && listError.status === 404) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-md text-center text-[13px] text-text-tertiary">
            <p className="text-error">Artifacts unavailable for this run.</p>
            <p className="mt-2">
              Archon could not resolve where this run&apos;s output was written — the run record may
              have been deleted, or its project may no longer be registered.
            </p>
            <p className="mt-2 font-mono text-[11px]">
              This is not the same as &ldquo;the run produced nothing&rdquo;.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="p-6 font-mono text-[12px] text-error">
        Could not list artifacts: {listError.message}
      </div>
    );
  }
  if (files === undefined || files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center text-[13px] text-text-tertiary">
          <p>No artifacts written to disk for this run.</p>
          <p className="mt-2 font-mono text-[11px]">
            Workflows that emit reports or plans write them to{' '}
            <code className="rounded bg-surface-inset px-1">$ARTIFACTS_DIR</code>.
          </p>
        </div>
      </div>
    );
  }

  // The lightbox walks this run's images in the order the sidebar lists them.
  const images: LightboxImage[] = files.flatMap(f =>
    artifactKind(f.path) === 'image'
      ? [{ id: f.path, name: artifactBasename(f.path), url: artifactUrl(runId, f.path) }]
      : []
  );
  const previewIndex = images.findIndex(i => i.id === previewPath);
  const selectedFile = files.find(f => f.path === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 w-full">
      <ArtifactSidebar runId={runId} files={files} selected={selected} onSelect={setSelected} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {selectedFile !== null ? (
          <ArtifactViewer runId={runId} file={selectedFile} onOpenImage={setPreviewPath} />
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-text-tertiary">
            Pick a file from the left.
          </div>
        )}
      </div>
      {previewIndex !== -1 ? (
        <ImageLightbox
          images={images}
          index={previewIndex}
          onIndex={i => {
            setPreviewPath(images[i]?.id ?? null);
          }}
          onClose={() => {
            setPreviewPath(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface SidebarProps {
  runId: string;
  files: ArtifactFile[];
  selected: string | null;
  onSelect: (path: string) => void;
}

function ArtifactSidebar({ runId, files, selected, onSelect }: SidebarProps): ReactElement {
  return (
    <nav
      aria-label="Artifacts"
      className="flex h-full w-[260px] shrink-0 flex-col overflow-y-auto border-r border-border bg-surface-inset"
    >
      <header className="sticky top-0 z-10 border-b border-border bg-surface-inset px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
        Files · {files.length.toString()}
      </header>
      <ul className="flex flex-col gap-px p-2">
        {files.map(f => {
          const isSelected = selected === f.path;
          const basename = artifactBasename(f.path);
          const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : null;
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => {
                  onSelect(f.path);
                }}
                aria-pressed={isSelected}
                className={`group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors ${
                  isSelected ? 'bg-surface-elevated' : 'hover:bg-surface-hover'
                }`}
              >
                {artifactKind(f.path) === 'image' ? (
                  <SidebarThumb url={artifactUrl(runId, f.path)} name={basename} />
                ) : null}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    className={`truncate font-mono text-[12px] ${
                      isSelected ? 'text-text-primary' : 'text-text-secondary'
                    }`}
                  >
                    {basename}
                  </span>
                  <span className="flex items-center justify-between gap-2 font-mono text-[10px] text-text-tertiary">
                    <span className="truncate">{dir ?? '·'}</span>
                    <span className="shrink-0 tabular-nums">{formatArtifactSize(f.size)}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface SidebarThumbProps {
  url: string;
  name: string;
}

/**
 * 28px preview in the file list — a run with 40 screenshots is unreadable as
 * a column of names. Falls back to a neutral glyph if the image will not
 * decode, so the row never shows a broken-image icon.
 */
function SidebarThumb({ url, name }: SidebarThumbProps): ReactElement {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        aria-hidden
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-surface font-mono text-[10px] text-text-tertiary"
      >
        ▤
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      title={name}
      loading="lazy"
      onError={() => {
        setFailed(true);
      }}
      className="h-7 w-7 shrink-0 rounded border border-border object-cover"
    />
  );
}
