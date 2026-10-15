export type LogoKind = 'png' | 'jpg' | 'webp' | 'svg';

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean => signature.every((b, i) => bytes[at + i] === b);

/**
 * What a file really is, from its first bytes: the name and the type the browser reported are
 * whatever the sender typed. Returns null for anything that is not a plain picture. An SVG is a
 * picture only if it carries nothing that runs (scripts, event handlers, outside links).
 */
export function detectLogoKind(bytes: Uint8Array): LogoKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^\u{FEFF}/u, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) {
    const whole = new TextDecoder('utf-8', { fatal: false }).decode(bytes).toLowerCase();
    const runs = /<script|<foreignobject|<iframe|<embed|<object|\son[a-z]+\s*=|javascript:|data:text\/html|<!entity|xlink:href\s*=\s*["']\s*(?!#)/.test(whole);
    return runs ? null : 'svg';
  }
  return null;
}

export const LOGO_MIME: Record<LogoKind, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
