import { textColorFor } from '@/config/company-ui/banner-colors';
import type { PromoBanner } from '@/config/company-ui/types';

export interface BannerLook {
  /** True when the company chose its own colours; false is the shop's own look. */
  custom: boolean;
  /** Inline colours for a custom banner, otherwise nothing. */
  style: { backgroundColor?: string; color?: string };
  /** The button: the text colour on the background colour, so it reads as well as the words do. */
  buttonStyle: { backgroundColor?: string; color?: string };
  /** Seconds for one trip across for a marquee. */
  seconds: number;
}

const SECONDS = { slow: 45, normal: 28, fast: 14 } as const;

/** How a banner is drawn. The text colour is always one that can be read on the background. */
export function bannerLook(banner: Pick<PromoBanner, 'background' | 'textColor' | 'speed'>): BannerLook {
  const seconds = SECONDS[banner.speed];
  if (banner.background === '') return { custom: false, style: {}, buttonStyle: {}, seconds };
  const text = textColorFor(banner.background, banner.textColor);
  return {
    custom: true,
    style: { backgroundColor: banner.background, color: text },
    buttonStyle: { backgroundColor: text, color: banner.background },
    seconds,
  };
}
