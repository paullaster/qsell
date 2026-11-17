import type { SmsProviderId } from '@/lib/sms-providers';
import type { SmsPort } from '@/server/ports/sms';
import { AfricasTalkingSms } from './africastalking';
import type { Fetch } from './http';
import { LogSms } from './log';
import { TwilioSms } from './twilio';

/**
 * The adapter for a provider, from the company's saved settings and (opened) secrets. Null when something the provider needs is missing, so a
 * half-set account is never used to send.
 */
export function smsAdapter(id: SmsProviderId, settings: Record<string, string>, secrets: Record<string, string>, fetchFn?: Fetch): SmsPort | null {
  if (id === 'log') return new LogSms();
  if (id === 'africastalking') {
    const { username, senderId } = settings;
    const key = secrets.apiKey;
    return username === undefined || key === undefined ? null : new AfricasTalkingSms({ username, ...(senderId === undefined ? {} : { senderId }) }, key, fetchFn);
  }
  const { accountSid, from } = settings;
  const token = secrets.authToken;
  return accountSid === undefined || from === undefined || token === undefined ? null : new TwilioSms({ accountSid, from }, token, fetchFn);
}
