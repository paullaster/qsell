import nodemailer from 'nodemailer';
import type { EmailMessage, EmailPort, EmailSendResult } from '@/server/ports/communications';

export class ConsoleEmailAdapter implements EmailPort {
  readonly name = 'console';

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const id = `console_${Date.now()}`;
    console.warn('[ConsoleEmailAdapter] Outbound email', {
      id,
      to: message.to,
      subject: message.subject,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        bytes: a.content.length,
      })),
      textPreview: (message.text || message.html).slice(0, 180),
    });
    return { messageId: id, provider: this.name };
  }
}

/** First value that is set and not blank; env vars are often present but empty. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value): value is string => value !== undefined && value.trim() !== '');
}

export class NodemailerSmtpAdapter implements EmailPort {
  readonly name = 'smtp';
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(options?: {
    host?: string;
    port?: number;
    user?: string;
    pass?: string;
    from?: string;
    secure?: boolean;
  }) {
    // Accept both SMTP_* and the EMAIL_SMTP_* names documented in .env.example.
    const env = process.env;
    const host = firstNonEmpty(options?.host, env.SMTP_HOST, env.EMAIL_SMTP_HOST) ?? 'localhost';
    const port = options?.port ?? Number(firstNonEmpty(env.SMTP_PORT, env.EMAIL_SMTP_PORT) ?? 587);
    const user = firstNonEmpty(options?.user, env.SMTP_USER, env.EMAIL_SMTP_USER) ?? '';
    const pass = firstNonEmpty(options?.pass, env.SMTP_PASS, env.EMAIL_SMTP_PASSWORD) ?? '';
    const fromAddress = firstNonEmpty(env.EMAIL_FROM);
    const documentedFrom =
      fromAddress === undefined
        ? undefined
        : `${firstNonEmpty(env.EMAIL_FROM_NAME) ?? 'OmniCommerce'} <${fromAddress}>`;
    this.from =
      firstNonEmpty(options?.from, env.SMTP_FROM, documentedFrom) ??
      'OmniCommerce <noreply@omnicommerce.ke>';

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: options?.secure ?? port === 465,
      auth: user ? { user, pass } : undefined,
    });
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const info = await this.transporter.sendMail({
      from: message.fromOverride || this.from,
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });

    return {
      messageId: String(info.messageId || `smtp_${Date.now()}`),
      provider: this.name,
    };
  }
}
