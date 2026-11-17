import type { SmsMessage, SmsPort, SmsReceipt } from '@/server/ports/sms';
import { maskedPhone } from '@/lib/sms-providers';

/** Sends nothing: writes that a message would have gone (to a number with its middle hidden, and its length, never its words) to the server log. */
export class LogSms implements SmsPort {
  send(message: SmsMessage): Promise<SmsReceipt> {
    console.warn('[sms:log] would send', { to: maskedPhone(message.to), characters: message.text.length });
    return Promise.resolve({ providerMessageId: null });
  }
}
