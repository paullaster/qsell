'use client';

import Image, { type ImageProps } from 'next/image';
import { useState } from 'react';
import { firstFilled, has } from '@/lib/values';

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
  // Which picture failed to load; a different picture starts afresh, without any effect to reset it.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc !== null && failedSrc === src;

  const source = firstFilled((failed ? fallbackSrc : src)?.trim(), fallbackSrc) ?? '';
  const legacyCompanyLogo = /^\/uploads\/company\/(logo-[a-zA-Z0-9._-]+)$/.exec(source);
  const logoName = legacyCompanyLogo?.[1];
  const resolved = logoName === undefined ? source : `/api/company/logo/${encodeURIComponent(logoName)}`;
  if (!has(resolved)) return null;

  return (
    <Image
      {...rest}
      src={resolved}
      alt={alt}
      unoptimized={unoptimized === true || needsUnoptimized(resolved) || resolved.startsWith('/api/company/logo/')}
      onError={(event) => {
        if (has(fallbackSrc) && resolved !== fallbackSrc) setFailedSrc(src ?? null);
        onError?.(event);
      }}
    />
  );
}
