/** Web push (DI): sending a short alert to a browser that agreed to receive them. Adapters implement it; domain code depends on this only. */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Where tapping the alert opens, on this site. */
  url: string;
  /** Alerts with the same tag replace each other on the phone. */
  tag: string;
}

export interface PushPort {
  /** The public key a browser needs to subscribe, or null when this installation has not been set up for push. */
  publicKey(): string | null;
  /** `gone` means the browser no longer listens (the push service says so) and the subscription should be removed. Any other failure throws. */
  send(target: PushTarget, message: PushMessage): Promise<'sent' | 'gone'>;
}
