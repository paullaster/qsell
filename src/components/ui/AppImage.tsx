'use client';

import Image, { type ImageProps } from 'next/image';
import { useEffect, useState } from 'react';

type AppImageProps = Omit<ImageProps, 'src' | 'alt'> & {
  src?: string | null;
  alt: string;
  /** Shown if `src` is empty or fails to load. */
  fallbackSrc?: string;
};

function needsUnoptimized(src: string) {
  return src.startsWith('data:') || src.startsWith('blob:');
}

export const PRODUCT_IMAGE_FALLBACK =
  'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=600&q=80';

/** `next/image` wrapper for runtime product photos and uploaded logos. */
export function AppImage({ src, alt, fallbackSrc, onError, unoptimized, ...rest }: AppImageProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const resolved = (failed ? fallbackSrc : src)?.trim() || fallbackSrc || '';
  if (!resolved) return null;

  return (
    <Image
      {...rest}
      src={resolved}
      alt={alt}
      unoptimized={unoptimized || needsUnoptimized(resolved)}
      onError={(event) => {
        if (fallbackSrc && resolved !== fallbackSrc) setFailed(true);
        onError?.(event);
      }}
    />
  );
}
