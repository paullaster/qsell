/**
 * SMS (DI): sending a text message through whichever provider a company has connected. Each client has its own provider, so adapters
 * implement this and the company's settings choose which one is used; domain code depends on this port only.
 */

export interface SmsMessage {
  /** International form, +254… */
  to: string;
  text: string;
}

export interface SmsReceipt {
  /** The provider's own id for the message, when it gives one. */
  providerMessageId: string | null;
}

/**
 * A send that did not work, with words that are safe to show: never the provider's raw answer, a key, or an internal error. `retry` says whether
 * trying again later could work (the provider was unreachable or busy) or never will (a wrong key, a number it refuses, no balance).
 */
export class SmsSendError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message);
    this.name = 'SmsSendError';
  }
}

export interface SmsPort {
  send(message: SmsMessage): Promise<SmsReceipt>;
}
