import { and, eq, ne } from 'drizzle-orm';
import { users } from '@/server/db/drizzle/schema';
import { resolveCompanyUiConfig } from '@/config/company-ui';
import { getContainer } from '@/server/di/container';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { SOURCE_KINDS, type SourceKind } from './email-routes';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The kinds of place an address can be found, as the screen's first choice when adding someone. */
const KIND_WORDS: Record<(typeof SOURCE_KINDS)[number], { label: string; description: string }> = {
  staff: { label: 'A staff member', description: 'Pick a person; their account email is used and follows any change to it' },
  company: { label: 'The company email', description: 'The address in Company Setup' },
  channel: { label: 'A support channel', description: 'An email channel added in Company Setup, Support' },
  customer: { label: 'The customer', description: 'The shopper or the customer on the document' },
  actor: { label: 'The staff member who sends it', description: 'Whoever pressed Send' },
  owner: { label: 'The staff member who made the quote', description: 'Not present on a quote a shopper asked for' },
  address: { label: 'An address I type', description: 'For the odd one-off' },
};

/** Active staff accounts (not customers), for choosing who is written to. */
const staffList = (key: string, permission: PermissionKey) => tableSource({
  key,
  permission,
  table: users,
  id: users.id,
  label: users.name,
  searchColumns: [users.name, users.email],
  select: { email: users.email },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [ne(users.role, 'customer'), and(eq(users.status, 'active'), eq(users.isActive, true)) ?? eq(users.status, 'active')];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
});

/** The company's email support channels. */
const channelList = (key: string, permission: PermissionKey) => staticSource({
  key,
  permission,
  items: async ({ companyId }) => {
    const row = await getContainer().companySettings.ensureSeeded();
    if (row.id !== companyId) return [];
    return resolveCompanyUiConfig(row.uiConfig)
      .support.channels.filter((c) => c.kind === 'email')
      .map((c) => ({ id: c.id, label: c.label === '' ? c.value : c.label, description: c.value, badge: null }));
  },
});

const kinds = (key: string, permission: PermissionKey, allowed: readonly SourceKind[]) => staticSource({
  key,
  permission,
  items: () => allowed.map((id) => ({ id, label: KIND_WORDS[id].label, description: KIND_WORDS[id].description, badge: null })),
});

/** Where a quote's own business emails can be found: no customer (they are the reader) and no one who sends (the quote is not being sent). */
const QUOTE_KINDS: readonly SourceKind[] = ['staff', 'company', 'channel', 'owner', 'address'];

export const EMAIL_ROUTING_LOOKUP_SOURCES: LookupSource[] = [
  staffList('email-routing-staff', 'email_routing:manage'),
  channelList('email-routing-channels', 'email_routing:manage'),
  kinds('email-routing-source-kinds', 'email_routing:manage', SOURCE_KINDS),
  // The quote editor picks a quote's own contacts with the permission to change quotes, not the one to set up Email routing.
  staffList('quote-contact-staff', 'quotes:update'),
  channelList('quote-contact-channels', 'quotes:update'),
  kinds('quote-contact-source-kinds', 'quotes:update', QUOTE_KINDS),
];
