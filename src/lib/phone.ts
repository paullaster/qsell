import { has } from '@/lib/values';

/** 07XX, 01XX, 7XX, +254… and 254… all become 2547XXXXXXXX / 2541XXXXXXXX. Null when it cannot be a Kenyan mobile number. */
export function toKenyanMsisdn(raw: string | null | undefined): string | null {
  if (!has(raw)) return null;
  let digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  else if (digits.length === 9 && /^[17]/.test(digits)) digits = `254${digits}`;
  return /^254[17]\d{8}$/.test(digits) ? digits : null;
}

/** How a person reads a number: 0712 345 678. Anything that is not a Kenyan mobile number is returned as written. */
export function nationalPhone(raw: string | null | undefined): string {
  const msisdn = toKenyanMsisdn(raw);
  if (msisdn === null) return (raw ?? '').trim();
  const local = `0${msisdn.slice(3)}`;
  return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
}

/** The same number with the middle hidden, for a page the customer may leave open or share: 0712 ••• 678. */
export function maskedPhone(raw: string | null | undefined): string {
  const msisdn = toKenyanMsisdn(raw);
  if (msisdn === null) return '';
  const local = `0${msisdn.slice(3)}`;
  return `${local.slice(0, 4)} ••• ${local.slice(7)}`;
}

/** Whether two written numbers are the same line (07xx and +2547xx agree). */
export function sameMobile(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = toKenyanMsisdn(a);
  return left !== null && left === toKenyanMsisdn(b);
}
