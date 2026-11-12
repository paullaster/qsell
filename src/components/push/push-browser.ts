/** Browser side of alerts: is it possible here, subscribing and unsubscribing this browser. Nothing here is trusted by the server. */

export type Support = 'yes' | 'no';

export const canPush = (): Support =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'yes' : 'no';

/** The key as the browser wants it. */
function keyBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64Url.length / 4) * 4, '=');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(workerUrl: string, scope: string): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(workerUrl, { scope });
  return await navigator.serviceWorker.ready.then(async (ready) => (ready.scope.endsWith(scope) || ready.scope.endsWith(`${scope}/`) ? ready : ((await navigator.serviceWorker.getRegistration(scope)) ?? ready)));
}

/** Whether this very browser is subscribed now (the server counts browsers; this says whether it is this one). */
export async function thisBrowserEndpoint(workerUrl: string, scope: string): Promise<string | null> {
  try {
    const r = await registration(workerUrl, scope);
    return (await r.pushManager.getSubscription())?.endpoint ?? null;
  } catch {
    return null;
  }
}

export type Subscribed = { ok: true; subscription: { endpoint: string; p256dh: string; auth: string } } | { ok: false; error: string };

/** Asks permission (this must run from a tap), then subscribes with the shop's key. */
export async function subscribeThisBrowser(workerUrl: string, scope: string, publicKey: string): Promise<Subscribed> {
  try {
    if (Notification.permission === 'denied') return { ok: false, error: 'Alerts are blocked for this site in the browser. Allow notifications in the browser settings, then try again.' };
    const asked = await Notification.requestPermission();
    if (asked !== 'granted') return { ok: false, error: 'Alerts were not allowed. Allow notifications when the browser asks.' };
    const r = await registration(workerUrl, scope);
    const sub = (await r.pushManager.getSubscription()) ?? (await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    const json = sub.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (json.endpoint === undefined || p256dh === undefined || auth === undefined) return { ok: false, error: 'This browser could not set up alerts.' };
    return { ok: true, subscription: { endpoint: json.endpoint, p256dh, auth } };
  } catch {
    return { ok: false, error: 'This browser could not set up alerts. Try again, or use another browser.' };
  }
}

export async function unsubscribeThisBrowser(workerUrl: string, scope: string): Promise<string | null> {
  try {
    const r = await registration(workerUrl, scope);
    const sub = await r.pushManager.getSubscription();
    if (sub === null) return null;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}
