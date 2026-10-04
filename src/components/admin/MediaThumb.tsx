'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { AppImage } from '@/components/ui/AppImage';

/**
 * A square-cropped image that fills its (relatively positioned) parent. When the
 * image cannot load — a dead external link, say — it shows an honest placeholder
 * rather than a stand-in photo that would look like the product's own.
 */
export function MediaThumb({ src, alt, sizes }: { src: string; alt: string; sizes: string }) {
  // Remember which URL failed rather than a flag, so a new `src` is tried afresh without an effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src === '' || failedSrc === src) {
    return (
      <div
        role="img"
        aria-label={`${alt} (image unavailable)`}
        className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-sunken text-fg-subtle"
      >
        <ImageOff className="h-5 w-5" aria-hidden="true" />
        <span className="text-[10px]">Unavailable</span>
      </div>
    );
  }
  return (
    <AppImage
      src={src}
      alt={alt}
      fill
      sizes={sizes}
      className="object-cover"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  );
}
