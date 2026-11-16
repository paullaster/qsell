import { sendNotification } from 'web-push';
import type { PushMessage, PushPort, PushTarget } from '@/server/ports/push';
import type { PushRuntimeConfig } from './config';

const TTL_SECONDS = 60 * 60;

/** Sends through the browsers' push services. The alert is small, kept for an hour at most (a late alert is no use tomorrow), and urgent. */
export class WebPushAdapter implements PushPort {
  constructor(private readonly config: PushRuntimeConfig) {}

  publicKey(): string {
    return this.config.publicKey;
  }

  async send(target: PushTarget, message: PushMessage): Promise<'sent' | 'gone'> {
    try {
      await sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(message), {
        vapidDetails: { subject: this.config.subject, publicKey: this.config.publicKey, privateKey: this.config.privateKey },
        TTL: TTL_SECONDS,
        urgency: 'high',
        timeout: 10_000,
      });
      return 'sent';
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return 'gone';
      throw new Error(`The push service answered ${String(status ?? 'nothing')}.`, { cause: error });
    }
  }
}

/** Used when this installation has no push keys: nothing can subscribe and nothing is sent. */
export class NoPushAdapter implements PushPort {
  publicKey(): null {
    return null;
  }

  send(): Promise<'sent' | 'gone'> {
    return Promise.reject(new Error('Push is not set up on this installation.'));
  }
}
