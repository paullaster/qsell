/** How a product tile looks when it has no picture: its initials on a colour taken from its name, so a product always looks the same. */

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== '');
  const first = words[0]?.[0] ?? '?';
  const second = words.length > 1 ? (words[1]?.[0] ?? '') : (words[0]?.[1] ?? '');
  return `${first}${second}`.toUpperCase();
}

export function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export const kes = (amount: number): string => `KES ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
