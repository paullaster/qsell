import { SmsSendError, type SmsMessage, type SmsPort, type SmsReceipt } from '@/server/ports/sms';
import { callProvider, wordsForStatus, type Fetch } from './http';

const LIVE = 'https://api.africastalking.com/version1/messaging';
const SANDBOX = 'https://api.sandbox.africastalking.com/version1/messaging';

/** What Africa's Talking's status codes mean for the person, and whether trying again could help. */
const CODES: Record<number, [string, boolean]> = {
  401: ['The provider is holding the message for review (risk hold).', false],
  402: ['The sender name is not approved with Africa\'s Talking. Clear it in the settings to use their shared number, or get the name approved.', false],
  403: ['The provider says that is not a valid phone number.', false],
  404: ['The provider cannot send to that kind of number.', false],
  405: ['The Africa\'s Talking account has no balance. Top it up and try again.', false],
  406: ['That number has opted out of messages.', false],
  407: ['The provider could not find a way to reach that number.', true],
  500: ['The provider had a problem. Try again in a moment.', true],
  501: ['The provider had a problem. Try again in a moment.', true],
  502: ['The phone network refused the message.', false],
};

interface Reply {
  SMSMessageData?: { Recipients?: { statusCode?: number; messageId?: string }[] };
}

export class AfricasTalkingSms implements SmsPort {
  constructor(
    private readonly settings: { username: string; senderId?: string },
    private readonly apiKey: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  async send(message: SmsMessage): Promise<SmsReceipt> {
    const form = new URLSearchParams({ username: this.settings.username, to: message.to, message: message.text });
    if (this.settings.senderId !== undefined && this.settings.senderId !== '') form.set('from', this.settings.senderId);
    const { status, body } = await callProvider(this.fetchFn, this.settings.username === 'sandbox' ? SANDBOX : LIVE, {
      method: 'POST',
      headers: { apiKey: this.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (status < 200 || status >= 300) throw wordsForStatus(status);
    const recipient = (body as Reply | null)?.SMSMessageData?.Recipients?.[0];
    if (recipient === undefined) throw new SmsSendError('The provider did not say whether the message was sent.', false);
    const code = recipient.statusCode ?? 0;
    if (code >= 100 && code <= 102) return { providerMessageId: recipient.messageId ?? null };
    const known = CODES[code];
    throw new SmsSendError(known?.[0] ?? 'The provider refused the message.', known?.[1] ?? false);
  }
}
