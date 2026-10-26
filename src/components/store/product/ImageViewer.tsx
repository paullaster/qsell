'use client';

import { useCallback, useState } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';
import { AppImage } from '@/components/ui/AppImage';
import { useModalKeys } from '@/components/ui/useModalKeys';

/**
 * The pictures of a product at full size: the whole product is shown (never cropped), a tap zooms in to look closely,
 * and the arrow keys or a swipe move between pictures. A dialog: Escape closes it and focus goes back to the picture.
 */
export function ImageViewer({ images, name, start, onClose }: { images: string[]; name: string; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const dialogRef = useModalKeys<HTMLDivElement>(onClose);
  const count = images.length;
  const go = useCallback(
    (step: number) => {
      setIndex((current) => (current + step + count) % count);
      setZoomed(false);
    },
    [count],
  );
  const current = images[index] ?? '';
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Pictures of ${name}`}
      className="fixed inset-0 z-[60] flex flex-col bg-black/90"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight') go(1);
        if (event.key === 'ArrowLeft') go(-1);
      }}
    >
      <div className="flex items-center justify-between gap-2 p-3 text-white">
        <p aria-live="polite" className="text-sm">{String(index + 1)} of {String(count)}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => setZoomed((value) => !value)} aria-pressed={zoomed} aria-label={zoomed ? 'Zoom out' : 'Zoom in'} className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg bg-white/10 hover:bg-white/20">
            {zoomed ? <ZoomOut className="h-5 w-5" aria-hidden="true" /> : <ZoomIn className="h-5 w-5" aria-hidden="true" />}
          </button>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg bg-white/10 hover:bg-white/20">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className={`relative min-h-0 flex-1 ${zoomed ? 'overflow-auto' : 'overflow-hidden'}`}>
        <div className={zoomed ? 'relative h-[200%] w-[200%] min-w-[200%]' : 'relative h-full w-full'}>
          <AppImage key={current} src={current} alt={name} fill sizes="100vw" className="object-contain" referrerPolicy="no-referrer" />
        </div>
      </div>
      {count > 1 ? (
        <>
          <button type="button" onClick={() => go(-1)} aria-label="Previous picture" className="absolute top-1/2 left-2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/30">
            <ChevronLeft className="h-6 w-6" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => go(1)} aria-label="Next picture" className="absolute top-1/2 right-2 flex h-12 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/30">
            <ChevronRight className="h-6 w-6" aria-hidden="true" />
          </button>
        </>
      ) : null}
    </div>
  );
}
