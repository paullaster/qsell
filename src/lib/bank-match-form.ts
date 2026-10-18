/**
 * The matching-rules form: what each setting is called, the choices it offers, and how the text typed becomes the rules sent.
 * Pure. The server checks the rules again.
 */
export interface RulesForm {
  reference: string;
  minRefLength: string;
  amountTolerance: string;
  dateWindowDays: string;
  phone: string;
  name: string;
  nameMinScore: string;
  maxProposals: string;
}

export interface Rules {
  reference: string;
  minRefLength: number;
  amountToleranceCents: number;
  dateWindowDays: number;
  phone: string;
  name: string;
  nameMinScore: number;
  maxProposals: number;
}

export const CERTAINTY_CHOICES = [
  { id: 'auto', label: 'Match by itself' },
  { id: 'propose', label: 'Suggest only' },
  { id: 'off', label: 'Ignore' },
] as const;

export const SUGGEST_CHOICES = [
  { id: 'propose', label: 'Suggest only' },
  { id: 'off', label: 'Ignore' },
] as const;

export const labelOf = (list: readonly { id: string; label: string }[], id: string): string => list.find((c) => c.id === id)?.label ?? id;

export const toForm = (r: Rules): RulesForm => ({
  reference: r.reference,
  minRefLength: String(r.minRefLength),
  amountTolerance: (r.amountToleranceCents / 100).toFixed(2),
  dateWindowDays: String(r.dateWindowDays),
  phone: r.phone,
  name: r.name,
  nameMinScore: String(r.nameMinScore),
  maxProposals: String(r.maxProposals),
});

/** Whole numbers from text; anything else becomes NaN, which the server refuses with a clear message. */
const whole = (s: string): number => (/^\s*\d+\s*$/.test(s) ? Number(s) : Number.NaN);

export function toRules(f: RulesForm): Record<string, unknown> {
  const money = Number(f.amountTolerance.trim() === '' ? '0' : f.amountTolerance);
  return {
    reference: f.reference,
    minRefLength: whole(f.minRefLength),
    amountToleranceCents: Number.isFinite(money) ? Math.round(money * 100) : Number.NaN,
    dateWindowDays: whole(f.dateWindowDays),
    phone: f.phone,
    name: f.name,
    nameMinScore: Number(f.nameMinScore),
    maxProposals: whole(f.maxProposals),
  };
}

/** One sentence on what the rules do, for the top of the panel. */
export function describeRules(r: Rules): string {
  const parts: string[] = [];
  const known: Record<string, string> = { off: 'Our references on a line are ignored', auto: 'A line quoting our reference with the exact amount is matched by itself' };
  const reference = known[r.reference] ?? 'A line quoting our reference is suggested';
  parts.push(reference);
  if (r.phone !== 'off') parts.push(r.phone === 'auto' ? "a customer's phone number on a line with the exact amount closes it by itself" : "a customer's phone number on a line is suggested");
  if (r.name !== 'off') parts.push("a payer's name that resembles the customer's is suggested");
  parts.push(`same amount${r.amountToleranceCents > 0 ? ` (give or take ${(r.amountToleranceCents / 100).toFixed(2)})` : ''} within ${String(r.dateWindowDays)} day${r.dateWindowDays === 1 ? '' : 's'} is suggested`);
  return `${parts.join('; ')}.`;
}

export const SCOPE_WORDS: Record<string, string> = {
  account: 'This account has its own rules.',
  company: 'This account follows the rules for every account.',
  standard: 'No rules have been set: the standard ones apply.',
};

/** When a feed last heard from the bank, in words. */
export function feedWords(s: { enabled: boolean; lastReceivedAt: string | null; lastLines: number; receivedCount: number; lastError: string | null } | null, now: Date): string {
  if (s === null) return 'No feed. The bank cannot send lines here until one is made.';
  if (!s.enabled) return 'Switched off. The address no longer works.';
  if (s.lastReceivedAt === null) return 'Waiting for the first delivery.';
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(s.lastReceivedAt).getTime()) / 60000));
  const ago = agoWords(minutes);
  return `Last delivery ${ago}: ${String(s.lastLines)} new line${s.lastLines === 1 ? '' : 's'} (${String(s.receivedCount)} deliveries in all).`;
}

function agoWords(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`;
  if (minutes < 2880) return `${String(Math.round(minutes / 60))} hours ago`;
  return `${String(Math.round(minutes / 1440))} days ago`;
}
