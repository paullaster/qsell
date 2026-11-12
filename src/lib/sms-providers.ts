/**
 * The SMS providers a company can connect. Each client has its own, so a provider is a kind of connection with its own fields; adding one
 * is a new entry here and a new adapter in `server/adapters/sms`. Pure rules only: what each provider needs, how the form is checked,
 * what is a secret, and how a phone number is written for sending. The screen draws its form from this list.
 */

export const SMS_PROVIDER_IDS = ['africastalking', 'twilio', 'log'] as const;
export type SmsProviderId = (typeof SMS_PROVIDER_IDS)[number];
export const isSmsProviderId = (value: unknown): value is SmsProviderId => typeof value === 'string' && (SMS_PROVIDER_IDS as readonly string[]).includes(value);

export interface SmsField {
  key: string;
  label: string;
  /** A secret is sealed when saved and never shown again; the others are shown back to the person. */
  secret: boolean;
  required: boolean;
  hint: string;
  placeholder: string;
  /** Checked on the server; the browser only uses it to help. */
  pattern: RegExp;
  patternWords: string;
  maxLength: number;
}

export interface SmsProviderDefinition {
  id: SmsProviderId;
  name: string;
  summary: string;
  fields: readonly SmsField[];
}

const SENDER_ID = /^[A-Za-z0-9]{3,11}$/;

export const SMS_PROVIDERS: Record<SmsProviderId, SmsProviderDefinition> = {
  africastalking: {
    id: 'africastalking',
    name: "Africa's Talking",
    summary: 'Sends through your Africa\'s Talking account. Use the username "sandbox" and a sandbox key to try it without sending real messages.',
    fields: [
      { key: 'username', label: 'Username', secret: false, required: true, hint: 'The username of your Africa\'s Talking app (or "sandbox").', placeholder: 'yourshop', pattern: /^[A-Za-z0-9_.-]{2,40}$/, patternWords: 'letters, numbers, dots, dashes and underscores, 2 to 40 long', maxLength: 40 },
      { key: 'apiKey', label: 'API key', secret: true, required: true, hint: 'From the app\'s settings on Africa\'s Talking. Kept sealed; never shown again.', placeholder: '', pattern: /^[A-Za-z0-9_.-]{20,200}$/, patternWords: 'the key exactly as Africa\'s Talking gave it', maxLength: 200 },
      { key: 'senderId', label: 'Sender name (optional)', secret: false, required: false, hint: 'The name people see as the sender, 3 to 11 letters or numbers. It must be approved by Africa\'s Talking first. Leave empty to use their shared number.', placeholder: 'YOURSHOP', pattern: SENDER_ID, patternWords: '3 to 11 letters or numbers, no spaces', maxLength: 11 },
    ],
  },
  twilio: {
    id: 'twilio',
    name: 'Twilio',
    summary: 'Sends through your Twilio account, from a number you own or a messaging service.',
    fields: [
      { key: 'accountSid', label: 'Account SID', secret: false, required: true, hint: 'Starts with AC. On the Twilio console home page.', placeholder: 'AC…', pattern: /^AC[0-9a-fA-F]{32}$/, patternWords: 'AC followed by 32 letters or numbers', maxLength: 34 },
      { key: 'authToken', label: 'Auth token', secret: true, required: true, hint: 'On the Twilio console home page. Kept sealed; never shown again.', placeholder: '', pattern: /^[A-Za-z0-9]{20,64}$/, patternWords: 'the token exactly as Twilio gave it', maxLength: 64 },
      { key: 'from', label: 'Send from', secret: false, required: true, hint: 'A Twilio phone number like +254700000000, or a messaging service that starts with MG.', placeholder: '+254700000000', pattern: /^(\+[1-9][0-9]{7,14}|MG[0-9a-fA-F]{32})$/, patternWords: 'a number with its country code (+254…) or a messaging service (MG…)', maxLength: 34 },
    ],
  },
  log: {
    id: 'log',
    name: 'Write to the server log (for trying it out)',
    summary: 'Sends nothing. The message is written to the server log so the screens and the flow can be tried before a real provider is connected. Not for use with customers.',
    fields: [],
  },
};

export const smsProviderWords = (id: SmsProviderId): string => SMS_PROVIDERS[id].name;

export type CheckedProvider = { ok: true; settings: Record<string, string>; secrets: Record<string, string> } | { ok: false; error: string };

/**
 * Reads what was typed for a provider. Plain fields come back as `settings`, secrets as `secrets`. On a change, an empty secret keeps the
 * one already saved (`keepSecrets`); on a new account every required field must be there. Unknown fields are ignored, never stored.
 */
export function checkProvider(id: SmsProviderId, input: Record<string, unknown>, options: { keepSecrets: boolean }): CheckedProvider {
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of SMS_PROVIDERS[id].fields) {
    const raw = input[f.key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      if (f.secret && options.keepSecrets) continue;
      if (f.required) return { ok: false, error: `${f.label}: fill this in.` };
      continue;
    }
    if (value.length > f.maxLength || /[\r\n\0]/.test(value) || !f.pattern.test(value)) return { ok: false, error: `${f.label}: use ${f.patternWords}.` };
    if (f.secret) secrets[f.key] = value;
    else settings[f.key] = value;
  }
  return { ok: true, settings, secrets };
}

/**
 * A phone number in the form providers want (+ and the country code, digits only). A number starting 0 is taken as Kenyan (07… and 01…),
 * as is one starting 7 or 1 with nine digits; one with a + or 00 keeps its own country code. Null when it cannot be a mobile number.
 */
export function internationalPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const compact = raw.trim().replace(/[\s().-]/g, '');
  if (compact === '' || !/^\+?[0-9]+$/.test(compact)) return null;
  let digits = compact.startsWith('+') ? compact.slice(1) : compact;
  if (!compact.startsWith('+') && digits.startsWith('00')) digits = digits.slice(2);
  else if (!compact.startsWith('+') && digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  else if (!compact.startsWith('+') && /^[17][0-9]{8}$/.test(digits)) digits = `254${digits}`;
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  if (digits.startsWith('254') && !/^254[17][0-9]{8}$/.test(digits)) return null;
  return `+${digits}`;
}

/** A number with the middle hidden, for the places that record a test without keeping the whole number. */
export const maskedPhone = (e164: string): string => (e164.length <= 6 ? '***' : `${e164.slice(0, 4)}***${e164.slice(-3)}`);

export const TEST_MESSAGE = (shop: string): string => `Test message from ${shop.slice(0, 60)}: your SMS provider is connected.`;
