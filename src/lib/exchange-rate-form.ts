/** What is wrong with the rate form as filled in, or null. The server checks again; this is for convenience. */
export function rateFormProblem(f: { currency: string; effectiveOn: string; rate: string }, today: string): string | null {
  if (f.currency.trim() === '') return 'Choose the currency.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.effectiveOn)) return 'Choose the day the rate starts.';
  if (f.effectiveOn < today) return 'A rate cannot be set for a day that has passed.';
  if (!/^\d+(\.\d{1,8})?$/.test(f.rate.trim()) || !(Number(f.rate) > 0)) return 'A rate is a number above zero with at most 8 decimals, such as 129.5.';
  return null;
}

/** "1 USD = 129.50 KES", the way a rate reads on the screen. */
export function rateWords(currency: string, rate: string, base: string): string {
  const [whole = '0', frac = ''] = rate.split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  return `1 ${currency} = ${whole}.${trimmed} ${base}`;
}

/** A revaluation's net as a sentence: gain, loss or none. */
export function netWords(net: string): string {
  const n = Number(net);
  if (!(Math.abs(n) >= 0.005)) return 'No difference';
  return n > 0 ? `Gain of ${n.toFixed(2)}` : `Loss of ${(-n).toFixed(2)}`;
}
