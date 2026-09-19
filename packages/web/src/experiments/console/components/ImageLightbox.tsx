import { useEffect, type ReactElement } from 'react';

/**
 * One image the viewer can show. Deliberately not tied to chat attachments:
 * run artifacts step through the same viewer, so callers map whatever they
 * hold (an object URL, an `/api/artifacts/...` URL) onto this shape.
 */
export interface LightboxImage {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}

/**
 * Full-screen viewer for one image. Escape closes, ← / → step through the
 * other images of the same set, a click on the backdrop closes. Rendered by
 * its owner (the composer, the artifact panel), so it needs no portal.
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

  if (current === undefined) return null;

  const step = (delta: number): void => {
    onIndex((index + delta + images.length) % images.length);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-[14px] bg-[rgba(0,0,0,0.82)] p-[24px] backdrop-blur-[2px]"
    >
      <img
        src={current.url}
        alt={current.name}
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
        <span className="max-w-[60vw] truncate">{current.name}</span>
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
