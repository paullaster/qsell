import type { BannerMotion, BannerSize, BannerSpeed } from '@/config/company-ui/types';

export interface BannerChoice {
  id: string;
  label: string;
}

export const BANNER_MOTION_CHOICES: (BannerChoice & { id: BannerMotion })[] = [
  { id: 'still', label: 'Still (the usual notice)' },
  { id: 'marquee', label: 'Scrolling marquee' },
  { id: 'pulse', label: 'Pulsing glow' },
];

export const BANNER_SPEED_CHOICES: (BannerChoice & { id: BannerSpeed })[] = [
  { id: 'slow', label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast', label: 'Fast' },
];

export const BANNER_SIZE_CHOICES: (BannerChoice & { id: BannerSize })[] = [
  { id: 'normal', label: 'Normal' },
  { id: 'large', label: 'Large, for a sale or a closing date' },
];

export const labelOfChoice = (choices: BannerChoice[], id: string): string => choices.find((c) => c.id === id)?.label ?? id;
