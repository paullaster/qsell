import { SUPPORT_KIND_CHOICES } from '@/lib/support-kinds';
import { acceptFilters, staticSource, type LookupSource } from '@/server/domains/lookups/runner';

export const COMPANY_LOOKUP_SOURCES: LookupSource[] = [
  staticSource({
    key: 'support-channel-kinds',
    permission: 'company:manage',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return SUPPORT_KIND_CHOICES.map((k) => ({ ...k, description: null }));
    },
  }),
];
