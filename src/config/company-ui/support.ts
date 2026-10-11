import { DEFAULT_COMPANY_SUPPORT_CONFIG } from './defaults';
import {
  SUPPORT_CHANNEL_KINDS,
  SUPPORT_LIMITS,
  type CompanySupportConfig,
  type SupportChannel,
  type SupportChannelKind,
  type SupportFaq,
  type SupportGuarantee,
} from './types';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function textOr(value: unknown, max: number, fallback: string): string {
  return text(value, max) || fallback;
}

/** Only http(s) links survive, so a stored `javascript:` URL can never reach an href. */
function safeHttpUrl(value: unknown): string {
  const raw = text(value, SUPPORT_LIMITS.url);
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : '';
  } catch {
    return '';
  }
}

function itemId(value: unknown, prefix: string, index: number): string {
  const id = text(value, 64);
  return id || `${prefix}-${index}`;
}

function sanitizeChannels(raw: unknown): SupportChannel[] {
  if (!Array.isArray(raw)) return [];
  const out: SupportChannel[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) continue;
    const value = text(item.value, SUPPORT_LIMITS.value);
    if (!value) continue;
    const kind = (SUPPORT_CHANNEL_KINDS as readonly unknown[]).includes(item.kind)
      ? (item.kind as SupportChannelKind)
      : 'other';
    out.push({
      id: itemId(item.id, 'channel', index),
      kind,
      label: text(item.label, SUPPORT_LIMITS.label),
      value,
      detail: text(item.detail, SUPPORT_LIMITS.detail),
      url: safeHttpUrl(item.url),
    });
    if (out.length >= SUPPORT_LIMITS.channels) break;
  }
  return out;
}

function sanitizeGuarantees(raw: unknown): SupportGuarantee[] {
  if (!Array.isArray(raw)) return [];
  const out: SupportGuarantee[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) continue;
    const body = text(item.text, SUPPORT_LIMITS.guarantee);
    if (!body) continue;
    out.push({ id: itemId(item.id, 'guarantee', index), text: body });
    if (out.length >= SUPPORT_LIMITS.guarantees) break;
  }
  return out;
}

function sanitizeFaqs(raw: unknown): SupportFaq[] {
  if (!Array.isArray(raw)) return [];
  const out: SupportFaq[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) continue;
    const question = text(item.question, SUPPORT_LIMITS.question);
    const answer = text(item.answer, SUPPORT_LIMITS.answer);
    if (!question || !answer) continue;
    out.push({ id: itemId(item.id, 'faq', index), question, answer });
    if (out.length >= SUPPORT_LIMITS.faqs) break;
  }
  return out;
}

/**
 * Normalize stored/submitted support JSON into a complete config.
 * Never throws; incomplete rows (no value / no answer) are dropped, titles fall back to defaults.
 */
export function resolveSupportConfig(raw: unknown): CompanySupportConfig {
  const source = isPlainObject(raw) ? raw : {};
  const d = DEFAULT_COMPANY_SUPPORT_CONFIG;
  return {
    name: textOr(source.name, SUPPORT_LIMITS.name, d.name),
    subtitle: text(source.subtitle, SUPPORT_LIMITS.subtitle),
    channels: sanitizeChannels(source.channels),
    guaranteesTitle: textOr(source.guaranteesTitle, SUPPORT_LIMITS.title, d.guaranteesTitle),
    guarantees: sanitizeGuarantees(source.guarantees),
    faqsTitle: textOr(source.faqsTitle, SUPPORT_LIMITS.title, d.faqsTitle),
    faqs: sanitizeFaqs(source.faqs),
  };
}

/** True when there is anything to show; the storefront hides its help entry points otherwise. */
export function hasSupportContent(support: CompanySupportConfig): boolean {
  return support.channels.length > 0 || support.guarantees.length > 0 || support.faqs.length > 0;
}

/** Link target for a channel, or null when it should render as plain text. */
export function supportChannelHref(channel: SupportChannel): string | null {
  const value = channel.value.trim();
  const digits = value.replace(/[^\d]/g, '');
  switch (channel.kind) {
    case 'phone':
      return digits ? `tel:${value.startsWith('+') ? '+' : ''}${digits}` : null;
    case 'sms':
      return digits ? `sms:${value.startsWith('+') ? '+' : ''}${digits}` : null;
    case 'whatsapp':
      return digits ? `https://wa.me/${digits}` : null;
    case 'email':
      return /^[^\s@]+@[^\s@]+$/.test(value) ? `mailto:${value}` : null;
    case 'telegram': {
      const handle = value.replace(/^@/, '');
      return /^[A-Za-z0-9_]{3,64}$/.test(handle)
        ? `https://t.me/${handle}`
        : safeHttpUrl(value) || null;
    }
    case 'website':
      return channel.url || safeHttpUrl(value) || null;
    case 'location':
    case 'other':
      return channel.url || null;
  }
}
