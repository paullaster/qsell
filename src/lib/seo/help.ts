import { supportChannelHref, type CompanySupportConfig, type SupportChannelKind } from '@/config/company-ui';
import { has } from '@/lib/values';
import { clip, placeOf, type SeoCompany } from './text';

export interface HelpContact {
  key: string;
  label: string;
  value: string;
  detail: string;
  href: string | null;
  kind: SupportChannelKind | 'address';
}

export interface HelpView {
  title: string;
  intro: string;
  contacts: HelpContact[];
  guaranteesTitle: string;
  guarantees: string[];
  faqsTitle: string;
  faqs: { id: string; question: string; answer: string }[];
  description: string;
}

interface HelpCompany extends SeoCompany {
  email: string;
  phone: string;
  streetAddress: string;
}

/**
 * What the public help page says, from the company's own setup: its contacts (profile first, then the channels it added),
 * its guarantees and its questions. Never empty: the profile alone gives an address, a phone number and an email.
 */
export function helpView(company: HelpCompany, support: CompanySupportConfig): HelpView {
  const profile: HelpContact[] = [
    ...(has(company.phone) ? [{ key: 'profile-phone', label: 'Phone', value: company.phone, detail: '', href: supportChannelHref({ id: 'p', kind: 'phone', label: '', value: company.phone, detail: '', url: '' }), kind: 'phone' as const }] : []),
    ...(has(company.email) ? [{ key: 'profile-email', label: 'Email', value: company.email, detail: '', href: supportChannelHref({ id: 'e', kind: 'email', label: '', value: company.email, detail: '', url: '' }), kind: 'email' as const }] : []),
    ...(has(company.streetAddress) ? [{ key: 'profile-address', label: 'Visit us', value: `${company.streetAddress}, ${placeOf(company)}`, detail: '', href: null, kind: 'address' as const }] : []),
  ];
  const added: HelpContact[] = support.channels.map((channel) => ({
    key: channel.id,
    label: has(channel.label) ? channel.label : channel.kind,
    value: channel.value,
    detail: channel.detail,
    href: supportChannelHref(channel),
    kind: channel.kind,
  }));
  const seen = new Set<string>();
  const contacts = [...profile, ...added].filter((contact) => {
    const key = contact.value.replace(/[^\p{L}\p{N}@.]/gu, '').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const faqs = support.faqs.filter((faq) => has(faq.question) && has(faq.answer));
  const title = `${support.name}: contact, delivery and questions`;
  const intro = has(support.subtitle) ? support.subtitle : `Contact ${company.tradingName}${has(placeOf(company)) ? ` in ${placeOf(company)}` : ''}, read what we promise, and find answers to common questions.`;
  const firstQuestion = faqs.length > 0 ? faqs[0].question : '';
  const description = clip(has(firstQuestion) ? `${intro} ${firstQuestion}` : intro, 160);
  return {
    title,
    intro,
    contacts,
    guaranteesTitle: support.guaranteesTitle,
    guarantees: support.guarantees.map((guarantee) => guarantee.text).filter((text) => has(text)),
    faqsTitle: support.faqsTitle,
    faqs,
    description,
  };
}
