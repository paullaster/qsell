export interface PushRuntimeConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or `https:` address the push services may use to reach whoever runs this installation. */
  subject: string;
}

const filled = (value: string | undefined): string | null => {
  const v = value?.trim() ?? '';
  return v === '' ? null : v;
};

const KEY = /^[A-Za-z0-9_-]{40,100}$/;

/**
 * Push is set by each installation: a key pair (made once with `npx web-push generate-vapid-keys`) and a contact. With none set, push is off
 * and everything else works as before (the mails still go). A half-set or malformed configuration is an error, never a silent off.
 */
export function pushRuntimeConfig(env: Readonly<Record<string, string | undefined>>): PushRuntimeConfig | null {
  const publicKey = filled(env.VAPID_PUBLIC_KEY);
  const privateKey = filled(env.VAPID_PRIVATE_KEY);
  const subject = filled(env.VAPID_SUBJECT);
  if (publicKey === null && privateKey === null && subject === null) return null;
  if (publicKey === null || privateKey === null || subject === null) throw new Error('Push needs VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT together.');
  if (!KEY.test(publicKey) || !KEY.test(privateKey)) throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be the keys web-push generated.');
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: address or an https: address.');
  return { publicKey, privateKey, subject };
}
