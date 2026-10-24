import type { EmailMessage } from '@/server/ports/communications';

/** Rendered account emails. Pure functions: no I/O, trivially testable. */

interface AccountEmailInput {
  to: string;
  recipientName: string;
  storeName: string;
  actionUrl: string;
  /** Human-readable lifetime of the link, e.g. "24 hours". */
  validFor: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function layout(args: {
  heading: string;
  greeting: string;
  body: string;
  cta: string;
  actionUrl: string;
  footer: string;
  /** Label/value rows shown in a box under the body, e.g. sign-in details. */
  details?: readonly (readonly [label: string, value: string])[];
}): string {
  const url = escapeHtml(args.actionUrl);
  const details =
    args.details === undefined
      ? ''
      : `<table role="presentation" style="margin:0 0 20px;border-collapse:collapse;background:#f3f4f6;border-radius:8px;width:100%">${args.details
          .map(
            ([label, value]) =>
              `<tr><td style="padding:8px 12px;font-size:13px;color:#4b5563;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:8px 12px;font-family:Consolas,Menlo,monospace;font-size:14px;color:#111827;word-break:break-all">${escapeHtml(value)}</td></tr>`,
          )
          .join('')}</table>`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:520px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px">${escapeHtml(args.heading)}</h2>
<p style="margin:0 0 12px">${escapeHtml(args.greeting)}</p>
<p style="margin:0 0 20px">${escapeHtml(args.body)}</p>
${details}
<p style="margin:0 0 20px"><a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${escapeHtml(args.cta)}</a></p>
<p style="margin:0 0 12px;font-size:13px;color:#4b5563">If the button doesn't work, paste this link into your browser:<br><a href="${url}" style="color:#4f46e5;word-break:break-all">${url}</a></p>
<p style="margin:16px 0 0;font-size:12px;color:#6b7280">${escapeHtml(args.footer)}</p>
</div>`;
}

export function verificationEmail(input: AccountEmailInput): EmailMessage {
  const greeting = `Hi ${input.recipientName},`;
  const body = `Confirm your email address to finish setting up your ${input.storeName} account.`;
  const footer = `This link expires in ${input.validFor}. If you didn't create an account, you can ignore this email.`;
  return {
    to: input.to,
    subject: `Confirm your email for ${input.storeName}`,
    html: layout({
      heading: 'Confirm your email',
      greeting,
      body,
      cta: 'Confirm email address',
      actionUrl: input.actionUrl,
      footer,
    }),
    text: `${greeting}\n\n${body}\n\n${input.actionUrl}\n\n${footer}`,
  };
}

export function passwordResetEmail(input: AccountEmailInput): EmailMessage {
  const greeting = `Hi ${input.recipientName},`;
  const body = `We received a request to reset the password for your ${input.storeName} account.`;
  const footer = `This link expires in ${input.validFor} and can be used once. If you didn't ask to reset your password, ignore this email — your password won't change.`;
  return {
    to: input.to,
    subject: `Reset your ${input.storeName} password`,
    html: layout({
      heading: 'Reset your password',
      greeting,
      body,
      cta: 'Choose a new password',
      actionUrl: input.actionUrl,
      footer,
    }),
    text: `${greeting}\n\n${body}\n\n${input.actionUrl}\n\n${footer}`,
  };
}

export function accountCreatedEmail(
  input: Omit<AccountEmailInput, 'validFor'> & { temporaryPassword: string },
): EmailMessage {
  const greeting = `Hi ${input.recipientName},`;
  const body = `An administrator has created a ${input.storeName} account for you. Sign in with the details below. You'll be asked to choose your own password straight away.`;
  const footer =
    "For your security, the temporary password stops working once you change it. If you weren't expecting this account, contact your administrator.";
  return {
    to: input.to,
    subject: `Your ${input.storeName} account is ready`,
    html: layout({
      heading: 'Your account is ready',
      greeting,
      body,
      details: [
        ['Email', input.to],
        ['Temporary password', input.temporaryPassword],
      ],
      cta: 'Sign in',
      actionUrl: input.actionUrl,
      footer,
    }),
    text: `${greeting}\n\n${body}\n\nEmail: ${input.to}\nTemporary password: ${input.temporaryPassword}\n\nSign in: ${input.actionUrl}\n\n${footer}`,
  };
}
