import { SUPPORT_KIND_CHOICES } from '@/lib/support-kinds';
import { BANNER_MOTION_CHOICES, BANNER_SIZE_CHOICES, BANNER_SPEED_CHOICES, type BannerChoice } from '@/lib/banner-choices';
import { acceptFilters, staticSource, type LookupSource } from '@/server/domains/lookups/runner';

const bannerChoices = (key: string, choices: BannerChoice[]): LookupSource =>
  staticSource({
    key,
    permission: 'company:manage',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return choices.map((c) => ({ ...c, description: null }));
    },
  });

export const COMPANY_LOOKUP_SOURCES: LookupSource[] = [
  staticSource({
    key: 'support-channel-kinds',
    permission: 'company:manage',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return SUPPORT_KIND_CHOICES.map((k) => ({ ...k, description: null }));
    },
  }),
  bannerChoices('banner-motions', BANNER_MOTION_CHOICES),
  bannerChoices('banner-speeds', BANNER_SPEED_CHOICES),
  bannerChoices('banner-sizes', BANNER_SIZE_CHOICES),
];
