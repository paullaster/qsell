/**
 * Settings every payment provider has, whatever the platform: how a payment is confirmed, who may
 * call us, and how long we keep asking. Non-secret, stored on the provider, edited on its card.
 * Anything missing or invalid falls back to the safe default.
 */
export interface VerificationSettings {
  /** standard: one platform query is enough. strict: also the transaction-level check where the platform has one. */
  mode: 'standard' | 'strict';
  /** Seconds after the request, or after the last answer of "still processing", at which we ask again. */
  pollSeconds: number[];
  /** After this many minutes without a final answer the payment is marked in doubt and left for a person. */
  windowMinutes: number;
}

export interface SecuritySettings {
  /** Callbacks are accepted only from these addresses ("1.2.3.4" or "1.2.3.0/24"). Empty = not checked. */
  allowedCidrs: string[];
  /** Largest callback body accepted, in bytes. */
  maxBodyBytes: number;
}

export interface EngineSettings {
  verification: VerificationSettings;
  security: SecuritySettings;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  verification: { mode: 'standard', pollSeconds: [15, 45, 120, 300, 900, 1800], windowMinutes: 120 },
  security: { allowedCidrs: [], maxBodyBytes: 64 * 1024 },
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);

export function engineSettings(raw: unknown): EngineSettings {
  const s = rec(raw);
  const v = rec(s.verification);
  const sec = rec(s.security);
  const poll = Array.isArray(v.pollSeconds) ? v.pollSeconds.filter((n): n is number => typeof n === 'number' && n >= 5 && n <= 86400) : [];
  const window = typeof v.windowMinutes === 'number' && v.windowMinutes >= 5 && v.windowMinutes <= 7 * 24 * 60 ? v.windowMinutes : DEFAULT_ENGINE_SETTINGS.verification.windowMinutes;
  const maxBody = typeof sec.maxBodyBytes === 'number' && sec.maxBodyBytes >= 1024 && sec.maxBodyBytes <= 1024 * 1024 ? sec.maxBodyBytes : DEFAULT_ENGINE_SETTINGS.security.maxBodyBytes;
  return {
    verification: {
      mode: v.mode === 'strict' ? 'strict' : 'standard',
      pollSeconds: poll.length > 0 ? poll : DEFAULT_ENGINE_SETTINGS.verification.pollSeconds,
      windowMinutes: window,
    },
    security: { allowedCidrs: strList(sec.allowedCidrs), maxBodyBytes: maxBody },
  };
}

/** Seconds until the next question after `asked` questions so far; the last interval repeats. */
export function nextPollDelay(s: VerificationSettings, asked: number): number {
  return s.pollSeconds[Math.min(asked, s.pollSeconds.length - 1)] ?? 60;
}

/**
 * How long to wait before asking again, from how old the payment is. Stateless on purpose: a restarted
 * worker, a callback that arrives, or a manual re-check all land on the same schedule.
 */
export function delayForAge(s: VerificationSettings, ageSeconds: number): number {
  let elapsed = 0;
  for (let i = 0; i < s.pollSeconds.length; i++) {
    elapsed += s.pollSeconds[i]!;
    if (ageSeconds < elapsed) return s.pollSeconds[i]!;
  }
  return s.pollSeconds[s.pollSeconds.length - 1] ?? 60;
}
