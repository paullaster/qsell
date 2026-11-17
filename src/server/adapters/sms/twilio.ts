import { SmsSendError, type SmsMessage, type SmsPort, type SmsReceipt } from '@/server/ports/sms';
import { callProvider, wordsForStatus, type Fetch } from './http';

/** Twilio error codes with a plain meaning; any other refusal is told without the provider's text. */
const CODES: Record<number, [string, boolean]> = {
  21211: ['The provider says that is not a valid phone number.', false],
  21608: ['The Twilio account is a trial and can send only to numbers verified in it.', false],
  21610: ['That number has opted out of messages.', false],
  21614: ['The provider says that is not a mobile number.', false],
  21606: ['The "send from" number cannot send messages. Check it in Twilio.', false],
  21408: ['The Twilio account is not allowed to send to that country. Turn it on in Twilio\'s geographic permissions.', false],
  20003: ['The provider did not accept the saved credentials. Check them in Settings > SMS providers.', false],
};

export class TwilioSms implements SmsPort {
  constructor(
    private readonly settings: { accountSid: string; from: string },
    private readonly authToken: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  async send(message: SmsMessage): Promise<SmsReceipt> {
    const form = new URLSearchParams({ To: message.to, Body: message.text });
    form.set(this.settings.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', this.settings.from);
    const { status, body } = await callProvider(this.fetchFn, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.settings.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.settings.accountSid}:${this.authToken}`).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (status === 201 || status === 200) return { providerMessageId: typeof (body as { sid?: unknown } | null)?.sid === 'string' ? (body as { sid: string }).sid : null };
    const code = (body as { code?: unknown } | null)?.code;
    const known = typeof code === 'number' ? CODES[code] : undefined;
    if (known !== undefined) throw new SmsSendError(known[0], known[1]);
    throw wordsForStatus(status);
  }
}
