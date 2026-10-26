'use client';

import { useRef, useState } from 'react';
import { Expand } from 'lucide-react';
import { AppImage } from '@/components/ui/AppImage';
import { ImagePlaceholder } from '@/components/store/ImagePlaceholder';
import { ImageViewer } from '@/components/store/product/ImageViewer';

const SWIPE_PX = 50;

/**
 * The product's pictures. The picture is shown whole on a plain background, as tall as fits on the screen (never
 * cropped, never so tall that the price is pushed out of sight). A tap opens it large to zoom; on a phone a swipe
 * changes picture; small pictures below choose which one is shown.
 */
export function ProductGallery({ images, name }: { images: string[]; name: string }) {
  const [selected, setSelected] = useState(0);
  const [viewing, setViewing] = useState(false);
  const touchStart = useRef<number | null>(null);
  const count = images.length;
  const current = images[selected] ?? '';
  const step = (by: number) => setSelected((value) => (value + by + count) % count);

  return (
    <div className="space-y-3">
      <div
        className="relative aspect-square max-h-[min(70dvh,40rem)] w-full overflow-hidden rounded-2xl border border-line bg-white"
        onPointerDown={(event) => {
          touchStart.current = event.pointerType === 'touch' ? event.clientX : null;
        }}
        onPointerUp={(event) => {
          if (touchStart.current === null || count < 2) return;
          const moved = event.clientX - touchStart.current;
          touchStart.current = null;
          if (Math.abs(moved) >= SWIPE_PX) step(moved < 0 ? 1 : -1);
        }}
      >
        {current === '' ? (
          <ImagePlaceholder />
        ) : (
          <>
            <AppImage key={current} src={current} alt={name} fill preload sizes="(max-width: 768px) 100vw, 50vw" className="object-contain p-2" referrerPolicy="no-referrer" />
            <button
              type="button"
              onClick={() => setViewing(true)}
              aria-label={`View ${name} full size`}
              className="absolute inset-0 flex cursor-zoom-in items-end justify-end p-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
            >
              <span className="flex h-9 items-center gap-1.5 rounded-lg bg-black/60 px-2.5 text-xs font-medium text-white"><Expand className="h-3.5 w-3.5" aria-hidden="true" />Zoom</span>
            </button>
          </>
        )}
      </div>
      {count > 1 ? (
        <ul aria-label={`Pictures of ${name}`} className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            <li key={image}>
              <button
                type="button"
                onClick={() => setSelected(index)}
                aria-label={`Show picture ${String(index + 1)} of ${String(count)}`}
                aria-pressed={index === selected}
                className={`relative block h-16 w-16 cursor-pointer overflow-hidden rounded-lg border-2 bg-white focus-visible:outline-2 focus-visible:outline-indigo-500 sm:h-20 sm:w-20 ${index === selected ? 'border-indigo-600' : 'border-line hover:border-line-strong'}`}
              >
                <AppImage src={image} alt="" fill sizes="80px" className="object-contain p-0.5" referrerPolicy="no-referrer" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {viewing ? <ImageViewer images={images} name={name} start={selected} onClose={() => setViewing(false)} /> : null}
    </div>
  );
}
