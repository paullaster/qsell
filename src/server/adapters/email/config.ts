import { isDeliverableAddress, isFromPolicy, FROM_POLICIES, type FromPolicy } from './sender';

export interface EmailRuntimeConfig {
  driver: 'console' | 'smtp';
  host: string | null;
  /** The address the mail server lets this instance send as: the envelope sender of every mail. Null for the console sink. */
  mailbox: string | null;
  /** Kept for callers that read the sender by its old name. */
  from: string | null;
  /** The display name for mail that names no business (account and vendor mail). */
  fromName: string | null;
  /** Whether the From header shows the mailbox or the business's own address; see sender.ts. */
  fromPolicy: FromPolicy;
}

const filled = (value: string | undefined): string | null => {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? null : normalized;
};

/** `Name <address>` or a bare address, taken apart. */
function splitSender(value: string | null): { address: string | null; name: string | null } {
  if (value === null) return { address: null, name: null };
  const named = /^(.*)<([^<>]+)>\s*$/.exec(value);
  if (named === null) return { address: value, name: null };
  const name = (named[1] ?? '').trim().replace(/^"|"$/g, '').trim();
  return { address: (named[2] ?? '').trim(), name: name === '' ? null : name };
}

/**
 * How an instance sends mail. Everything about the mail server is set here, per deployment, because servers differ: some only accept
 * mail from the account they log in as, others accept any From. Nothing has a built-in value, so a missing mailbox is an error, never
 * somebody else's address. Production email must be real SMTP delivery; console mode is only a local/test sink.
 */
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

  const policyWord = filled(env.EMAIL_FROM_POLICY)?.toLowerCase() ?? 'mailbox';
  if (!isFromPolicy(policyWord)) {
    throw new Error(`EMAIL_FROM_POLICY must be ${FROM_POLICIES.join(' or ')}.`);
  }

  const host = filled(env.EMAIL_SMTP_HOST) ?? filled(env.SMTP_HOST);
  const declaredSender = splitSender(filled(env.EMAIL_FROM) ?? filled(env.SMTP_FROM));
  const login = filled(env.EMAIL_SMTP_USER) ?? filled(env.SMTP_USER);
  // The mailbox is the address set for it, or else the login when the login is itself an address (the usual case).
  const address = declaredSender.address ?? (isDeliverableAddress(login) ? login : null);
  const fromName = filled(env.EMAIL_FROM_NAME) ?? declaredSender.name;

  const checked = !build && declared === 'smtp';
  if (checked && host === null) {
    throw new Error('SMTP needs EMAIL_SMTP_HOST (or SMTP_HOST): there is no built-in mail server.');
  }
  if (checked && !isDeliverableAddress(address)) {
    throw new Error('SMTP needs EMAIL_FROM (or SMTP_FROM) set to the mailbox address the mail server lets this instance send as, a real address such as mail@your-domain. There is no built-in sender.');
  }
  return { driver: declared, host, mailbox: isDeliverableAddress(address) ? address : null, from: address, fromName, fromPolicy: policyWord };
}
