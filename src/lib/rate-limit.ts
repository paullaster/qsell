/** Pure rules for the request limiter (design doc §17.1): which limit applies, which window a moment falls in, what to tell the person. */

export interface RateRule {
  /** How many tries a key gets in one window. */
  limit: number;
  /** The window, in seconds. */
  seconds: number;
}

export const RATE_RULES = {
  /** Sign-in: per address and per person, so changing address does not help against one account. */
  login_ip: { limit: 100, seconds: 900 },
  login_account: { limit: 8, seconds: 900 },
  /** A rider signing in with a phone number and PIN: per address, and per number so one rider's PIN cannot be guessed from many addresses. */
  rider_pin_ip: { limit: 40, seconds: 900 },
  rider_pin_phone: { limit: 12, seconds: 900 },
  /** Mail-sending forms: password reset, resend verification. */
  mail_ip: { limit: 10, seconds: 3600 },
  mail_account: { limit: 3, seconds: 3600 },
  /** Making an account. */
  register_ip: { limit: 10, seconds: 3600 },
  /** A shopper writing a product review, and anyone asking for the newsletter. */
  review_submit: { limit: 10, seconds: 3600 },
  newsletter_ip: { limit: 10, seconds: 3600 },
  newsletter_email: { limit: 3, seconds: 3600 },
  /** Payment prompts sent to a phone at checkout: per address, and per number so nobody's phone can be flooded. */
  payment_prompt_ip: { limit: 20, seconds: 900 },
  payment_prompt_phone: { limit: 4, seconds: 900 },
  /** A rider asking for prompts at the doors of a run: per rider, so one account cannot be used to flood phones. */
  door_prompt_rider: { limit: 12, seconds: 900 },
  /** A shopper pricing their delivery, and searching places or naming a pin on the map (each can call a map service). */
  shop_delivery_quote_ip: { limit: 120, seconds: 600 },
  /** A courier's system pushing news of parcels to its address: per source address, since one courier sends many a minute. */
  courier_webhook_ip: { limit: 600, seconds: 60 },
  shop_map_search_ip: { limit: 40, seconds: 600 },
  /** A customer looking up the code to collect an order: per address, and per order number so the number and contact cannot be guessed. */
  collection_lookup_ip: { limit: 30, seconds: 600 },
  collection_lookup_order: { limit: 8, seconds: 600 },
  /** Placing orders at the shop: per address and per phone, so one visitor cannot hold all the stock. */
  checkout_ip: { limit: 40, seconds: 900 },
  checkout_contact: { limit: 10, seconds: 3600 },
  /** Looking up an order by its number and the phone or email it was placed with: the number and contact cannot be guessed. */
  order_lookup_ip: { limit: 30, seconds: 600 },
  order_lookup_order: { limit: 8, seconds: 600 },
  /** Group orders: starting one (per address), opening a link and choosing in one (per address and per link, so a link cannot be hammered or filled with names). */
  group_create_ip: { limit: 10, seconds: 3600 },
  group_view_ip: { limit: 120, seconds: 600 },
  group_entry_ip: { limit: 40, seconds: 600 },
  group_entry_link: { limit: 150, seconds: 3600 },
  /** A customer opening their tracking page: per address, and per link so a link cannot be hammered. */
  tracking_ip: { limit: 60, seconds: 600 },
  tracking_token: { limit: 40, seconds: 600 },
  /** A signed-in vendor sending files or documents. */
  vendor_upload: { limit: 60, seconds: 600 },
  /** A signed-in vendor submitting an invoice, credit note or quotation, or asking a question. */
  vendor_submit: { limit: 40, seconds: 600 },
} as const satisfies Record<string, RateRule>;

export type RateRuleName = keyof typeof RATE_RULES;

/** The start of the window `now` falls in, as whole epoch seconds, so every instance agrees on the same window. */
export function windowStart(nowMs: number, seconds: number): number {
  const size = Math.max(1, Math.floor(seconds));
  return Math.floor(nowMs / 1000 / size) * size;
}

export function decide(hits: number, rule: RateRule, nowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  if (hits <= rule.limit) return { allowed: true, retryAfterSeconds: 0 };
  const end = windowStart(nowMs, rule.seconds) + rule.seconds;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(end - nowMs / 1000)) };
}

export function waitMessage(retryAfterSeconds: number): string {
  if (retryAfterSeconds < 90) return 'Too many attempts. Please wait a minute and try again.';
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes < 120 ? `Too many attempts. Please try again in about ${String(minutes)} minutes.` : 'Too many attempts. Please try again later.';
}

/**
 * The address a request came from. Our proxy sets X-Real-IP to the address that connected to it, so that is the one to trust;
 * without it, the last entry of X-Forwarded-For is the one the nearest proxy added (the first can be written by the caller).
 */
export function clientAddress(realIp: string | null, forwardedFor: string | null): string {
  const real = realIp?.trim() ?? '';
  if (real !== '' && real.length <= 64) return real;
  const parts = (forwardedFor ?? '').split(',').map((p) => p.trim()).filter((p) => p !== '');
  const last = parts[parts.length - 1] ?? '';
  return last !== '' && last.length <= 64 ? last : 'unknown';
}

/**
 * The rule with its limit multiplied by RATE_LIMIT_SCALE, for test servers that sign in far more often than any person would.
 * It is ignored in production, so a stray setting there cannot loosen the real limits.
 */
export function scaledRule(rule: RateRule, scale: string | undefined, production: boolean): RateRule {
  const factor = Number(scale);
  if (production || !Number.isFinite(factor) || factor < 1 || factor > 100_000) return rule;
  return { limit: Math.floor(rule.limit * factor), seconds: rule.seconds };
}
