import { SUPPORT_KIND_CHOICES } from '@/lib/support-kinds';
import { BANNER_MOTION_CHOICES, BANNER_SIZE_CHOICES, BANNER_SPEED_CHOICES, type BannerChoice } from '@/lib/banner-choices';
import { acceptFilters, staticSource, type LookupSource } from '@/server/domains/lookups/runner';
import { offsetLabel } from '@/lib/business-timezone';
import { timeZoneCatalogue } from './timezone-catalogue';

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
  // The time zones to choose from: the open list of IANA zones (or the system's own when it cannot be reached), each with how far it is from UTC.
  staticSource({
    key: 'business-timezones',
    permission: 'timezone:manage',
    items: async ({ filters }) => {
      acceptFilters(filters, {});
      const { zones } = await timeZoneCatalogue.zones();
      const now = new Date();
      return zones.map((zone) => ({ id: zone, label: zone, description: offsetLabel(zone, now) }));
    },
  }),
  bannerChoices('banner-motions', BANNER_MOTION_CHOICES),
  bannerChoices('banner-speeds', BANNER_SPEED_CHOICES),
  bannerChoices('banner-sizes', BANNER_SIZE_CHOICES),
];
