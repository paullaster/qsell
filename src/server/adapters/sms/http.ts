import { SmsSendError } from '@/server/ports/sms';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 10_000;

/** One request to a provider, with a time limit; a provider that cannot be reached or does not answer is a send that may be tried again. */
export async function callProvider(fetchFn: Fetch, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new SmsSendError('The SMS provider could not be reached. Try again in a moment.', true);
  }
  const body: unknown = await response.json().catch(() => null);
  return { status: response.status, body };
}

/** The words for the statuses every provider shares. Anything else is a refusal without detail. */
export function wordsForStatus(status: number): SmsSendError {
  if (status === 401 || status === 403) return new SmsSendError('The provider did not accept the saved credentials. Check them in Settings > SMS providers.', false);
  if (status === 429) return new SmsSendError('The provider is limiting how fast messages are sent. Try again in a moment.', true);
  if (status >= 500) return new SmsSendError('The SMS provider had a problem. Try again in a moment.', true);
  return new SmsSendError('The provider refused the message.', false);
}
