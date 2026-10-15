import { has } from '@/lib/values';

export interface BranchForm {
  code: string;
  name: string;
  actsIndependently: boolean;
}

export const emptyBranchForm = (): BranchForm => ({ code: '', name: '', actsIndependently: false });

/** The branch form as it is sent: codes are kept in capitals, names without stray spaces. */
export function branchPayload(form: BranchForm): { ok: true; payload: BranchForm } | { ok: false; error: string } {
  const code = form.code.trim().toUpperCase();
  const name = form.name.trim();
  if (!has(code)) return { ok: false, error: 'Give the branch a code.' };
  if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(code)) return { ok: false, error: 'A code is up to 20 letters, numbers, dots, dashes or underscores.' };
  if (!has(name)) return { ok: false, error: 'Give the branch a name.' };
  return { ok: true, payload: { code, name, actsIndependently: form.actsIndependently } };
}
