import { useState, type DragEvent as ReactDragEvent, type ReactElement } from 'react';
import { formatBytes, type Attachment } from '../primitives/file';

interface ChatAttachmentsProps {
  files: Attachment[];
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onOpen: (id: string) => void;
}

/**
 * The row of chips above the composer's textarea: image thumbnail (click to
 * open full screen), name, size, remove. Chips are draggable so the operator
 * can set the order the files are sent in — the agent reads them in this order.
 *
 * The drag events stop propagating: the composer itself listens for dropped
 * files, and a chip dragged onto a sibling must reorder, not re-attach.
 */
export function ChatAttachments({
  files,
  onRemove,
  onReorder,
  onOpen,
}: ChatAttachmentsProps): ReactElement {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const onDragStart = (e: ReactDragEvent<HTMLLIElement>, index: number): void => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    // Firefox starts no drag without payload; the index is kept in state.
    e.dataTransfer.setData('text/plain', String(index));
    setDragIndex(index);
  };

  const onDragOver = (e: ReactDragEvent<HTMLLIElement>, index: number): void => {
    if (dragIndex === null) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (overIndex !== index) setOverIndex(index);
  };

  const onDrop = (e: ReactDragEvent<HTMLLIElement>, index: number): void => {
    if (dragIndex === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (dragIndex !== index) onReorder(dragIndex, index);
    setDragIndex(null);
    setOverIndex(null);
  };

  const onDragEnd = (): void => {
    setDragIndex(null);
    setOverIndex(null);
  };

  return (
    <ul className="mb-2.5 flex flex-wrap gap-1.5">
      {files.map((f, index) => (
        <li
          key={f.id}
          draggable
          onDragStart={e => {
            onDragStart(e, index);
          }}
          onDragOver={e => {
            onDragOver(e, index);
          }}
          onDrop={e => {
            onDrop(e, index);
          }}
          onDragEnd={onDragEnd}
          title="Drag to reorder"
          className={`flex cursor-grab items-center gap-1.5 rounded-md border bg-[color:var(--surface-elevated)] py-1 pl-1.25 pr-1.25 text-console-12 transition-opacity active:cursor-grabbing ${
            dragIndex === index ? 'opacity-40' : ''
          }`}
          style={{
            borderColor:
              overIndex === index && dragIndex !== index
                ? 'var(--brand-magenta)'
                : 'var(--border-bright)',
          }}
        >
          {f.previewUrl !== null ? (
            <button
              type="button"
              onClick={() => {
                onOpen(f.id);
              }}
              aria-label={`Open ${f.file.name} full screen`}
              title="Open full screen"
              className="shrink-0 rounded-sm transition-opacity hover:opacity-80"
            >
              <img
                src={f.previewUrl}
                alt=""
                draggable={false}
                className="h-6.5 w-6.5 rounded-sm object-cover"
              />
            </button>
          ) : (
            <span aria-hidden className="pl-1 font-mono text-console-10 text-text-tertiary">
              ▤
            </span>
          )}
          <span className="max-w-45 truncate text-text-primary">{f.file.name}</span>
          <span className="font-mono text-console-10 text-text-tertiary">
            {formatBytes(f.file.size)}
          </span>
          <button
            type="button"
            onClick={() => {
              onRemove(f.id);
            }}
            aria-label={`Remove ${f.file.name}`}
            className="rounded p-px text-text-tertiary transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
          >
            <span aria-hidden className="text-console-11 leading-none">
              ✕
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
