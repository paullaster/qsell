import type { EmailMessage } from '@/server/ports/communications';
import { layout } from '@/server/domains/auth/emails';
import { newsletterBodyHtml } from '@/lib/newsletter';

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

/** One message of the news, with the way to stop receiving it. The text is the company's own, escaped; nothing in it runs as markup. */
export function newsletterMessageEmail(input: { to: string; storeName: string; subject: string; body: string; unsubscribeUrl: string }): EmailMessage {
  const url = input.unsubscribeUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const footer = `You are receiving this because you asked for news from ${input.storeName}.`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px">${input.subject.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</h2>${newsletterBodyHtml(input.body)}<p style="margin:24px 0 0;font-size:12px;color:#6b7280">${footer} <a href="${url}" style="color:#4f46e5">Unsubscribe</a></p></div>`;
  return { to: input.to, subject: input.subject, html, text: `${input.subject}\n\n${input.body}\n\n${footer}\nUnsubscribe: ${input.unsubscribeUrl}` };
}
