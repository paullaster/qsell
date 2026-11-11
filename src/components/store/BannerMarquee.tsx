'use client';

import { useState, type ReactNode } from 'react';
import { Pause, Play } from 'lucide-react';

const REPEATS = 8;

/**
 * The words of a banner scrolling across, like a marquee. It stops under the pointer or while something inside has focus,
 * has a Pause button, and does not move at all for people who ask their device for less motion. Screen readers get the
 * words once, from the banner itself; the moving copies are hidden from them.
 */
export function BannerMarquee({ children, seconds }: { children: ReactNode; seconds: number }) {
  const [paused, setPaused] = useState(false);
  const copy = (
    <div className="banner-marquee-copy flex shrink-0 items-center">
      {Array.from({ length: REPEATS }, (_, i) => (
        <span key={i} className="banner-marquee-seg flex shrink-0 items-center gap-3 pr-12">
          {children}
        </span>
      ))}
    </div>
  );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        aria-label={paused ? 'Play the scrolling banner' : 'Pause the scrolling banner'}
        className="banner-marquee-pause inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-current/40 hover:bg-black/10 focus-visible:outline-2 focus-visible:outline-current"
      >
        {paused ? <Play className="h-4 w-4" aria-hidden="true" /> : <Pause className="h-4 w-4" aria-hidden="true" />}
      </button>
      <div className="banner-marquee-viewport min-w-0 flex-1 overflow-hidden" aria-hidden="true">
        <div
          className="banner-marquee-track"
          style={{ ['--banner-duration' as string]: `${String(seconds)}s`, animationPlayState: paused ? 'paused' : undefined }}
        >
          {copy}
          {copy}
        </div>
      </div>
    </div>
  );
}
