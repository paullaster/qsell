export interface EmailRuntimeConfig {
  driver: 'console' | 'smtp';
  host: string | null;
  from: string | null;
}

const filled = (value: string | undefined): string | null => {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? null : normalized;
};

/** Production email must be configured for real delivery; console mode is only a local/test sink. */
export function emailRuntimeConfig(env: Readonly<Record<string, string | undefined>>): EmailRuntimeConfig {
  const production = env.NODE_ENV === 'production';
  const build = env.NEXT_PHASE === 'phase-production-build';
  const declared = filled(env.EMAIL_DRIVER)?.toLowerCase() ?? (production && !build ? '' : 'console');
  if (declared !== 'console' && declared !== 'smtp') {
    throw new Error('EMAIL_DRIVER must be smtp in production, or console/smtp outside production.');
  }
  if (production && !build && declared !== 'smtp') {
    throw new Error('Configure EMAIL_DRIVER=smtp before starting qsell in production; console mode does not deliver mail.');
  }
  const host = filled(env.EMAIL_SMTP_HOST) ?? filled(env.SMTP_HOST);
  const from = filled(env.EMAIL_FROM) ?? filled(env.SMTP_FROM);
  if (production && !build && declared === 'smtp' && (host === null || from === null)) {
    throw new Error('Production SMTP requires EMAIL_SMTP_HOST and EMAIL_FROM (or SMTP_HOST and SMTP_FROM).');
  }
  return { driver: declared, host, from };
}
