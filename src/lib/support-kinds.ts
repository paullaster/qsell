import type { SupportChannelKind } from '@/config/company-ui/types';

export interface SupportKindMeta {
  label: string;
  valueLabel: string;
  placeholder: string;
  showUrl: boolean;
}

/** How each kind of support channel is named and asked for. */
export const SUPPORT_KIND_META: Record<SupportChannelKind, SupportKindMeta> = {
  phone: { label: 'Phone call', valueLabel: 'Phone number', placeholder: '+254 700 000 000', showUrl: false },
  whatsapp: { label: 'WhatsApp', valueLabel: 'WhatsApp number', placeholder: '+254 700 000 000', showUrl: false },
  sms: { label: 'SMS', valueLabel: 'SMS number', placeholder: '+254 700 000 000', showUrl: false },
  email: { label: 'Email', valueLabel: 'Email address', placeholder: 'help@yourcompany.com', showUrl: false },
  location: { label: 'Location / branch', valueLabel: 'Address', placeholder: 'Street, building, town', showUrl: true },
  website: { label: 'Website / chat page', valueLabel: 'Page URL', placeholder: 'https://', showUrl: true },
  telegram: { label: 'Telegram', valueLabel: 'Username', placeholder: '@yourcompany', showUrl: false },
  other: { label: 'Other', valueLabel: 'Details', placeholder: '', showUrl: true },
};

export const SUPPORT_KIND_CHOICES: readonly { id: SupportChannelKind; label: string }[] = (Object.keys(SUPPORT_KIND_META) as SupportChannelKind[]).map((id) => ({ id, label: SUPPORT_KIND_META[id].label }));
