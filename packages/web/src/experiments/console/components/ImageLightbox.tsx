import { useEffect, type ReactElement } from 'react';
import type { Attachment } from '../primitives/file';

interface ImageLightboxProps {
  images: Attachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen viewer for an attached image. Escape closes, ← / → step through
 * the other attached images, a click on the backdrop closes. Rendered by the
 * composer, so it lives above the chat without a portal.
 */
export function ImageLightbox({
  images,
  index,
  onIndex,
  onClose,
}: ImageLightboxProps): ReactElement | null {
  const current = images[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (images.length < 2) return;
      if (e.key === 'ArrowRight') onIndex((index + 1) % images.length);
      if (e.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length);
    };
    window.addEventListener('keydown', onKey);
    return (): void => {
      window.removeEventListener('keydown', onKey);
    };
  }, [images.length, index, onIndex, onClose]);

  if (current?.previewUrl == null) return null;

  const step = (delta: number): void => {
    onIndex((index + delta + images.length) % images.length);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.file.name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-[14px] bg-[rgba(0,0,0,0.82)] p-[24px] backdrop-blur-[2px]"
    >
      <img
        src={current.previewUrl}
        alt={current.file.name}
        onClick={e => {
          e.stopPropagation();
        }}
        className="max-h-[82vh] max-w-[92vw] rounded-[8px] object-contain shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)]"
      />
      <div
        onClick={e => {
          e.stopPropagation();
        }}
        className="flex items-center gap-[12px] font-mono text-[11.5px] text-text-secondary"
      >
        {images.length > 1 ? (
          <button
            type="button"
            onClick={() => {
              step(-1);
            }}
            aria-label="Previous image"
            className="rounded px-[8px] py-[3px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
          >
            ←
          </button>
        ) : null}
        <span className="max-w-[60vw] truncate">{current.file.name}</span>
        {images.length > 1 ? (
          <>
            <span className="text-text-tertiary">
              {index + 1}/{images.length}
            </span>
            <button
              type="button"
              onClick={() => {
                step(1);
              }}
              aria-label="Next image"
              className="rounded px-[8px] py-[3px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
            >
              →
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded border px-[8px] py-[3px] transition-colors hover:bg-[color:var(--surface-hover)] hover:text-text-primary"
          style={{ borderColor: 'var(--border-bright)' }}
        >
          esc
        </button>
      </div>
    </div>
  );
}
