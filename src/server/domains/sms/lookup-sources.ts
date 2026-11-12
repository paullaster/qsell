import { SMS_PROVIDERS, SMS_PROVIDER_IDS } from '@/lib/sms-providers';
import { acceptFilters, staticSource, type LookupSource } from '@/server/domains/lookups/runner';

/** The SMS providers a connection can be made to. The list grows when an adapter is added. */
const smsProviders = staticSource({
  key: 'sms-providers',
  permission: 'sms:manage',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return SMS_PROVIDER_IDS.map((id) => ({ id, label: SMS_PROVIDERS[id].name, description: SMS_PROVIDERS[id].summary, badge: null }));
  },
});

export const SMS_LOOKUP_SOURCES: LookupSource[] = [smsProviders];
