import type { EmailMessage } from '@/server/ports/communications';
import { layout } from '@/server/domains/auth/emails';

/** The message that asks the person to confirm. Nothing else is sent until they do. */
export function newsletterConfirmEmail(input: { to: string; storeName: string; confirmUrl: string }): EmailMessage {
  const body = `Someone (we hope you) asked for news from ${input.storeName}. Confirm to start receiving it.`;
  return {
    to: input.to,
    subject: `Confirm your subscription to ${input.storeName}`,
    html: layout({ heading: 'Confirm your subscription', greeting: 'Hello,', body, cta: 'Confirm subscription', actionUrl: input.confirmUrl, footer: "If you didn't ask for this, ignore this email and nothing will be sent to you." }),
    text: `${body}\n\nConfirm: ${input.confirmUrl}\n\nIf you didn't ask for this, ignore this email.`,
  };
}
