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
    const host = options?.host || process.env.SMTP_HOST || 'localhost';
    const port = options?.port || Number(process.env.SMTP_PORT || 587);
    const user = options?.user || process.env.SMTP_USER || '';
    const pass = options?.pass || process.env.SMTP_PASS || '';
    this.from =
      options?.from || process.env.SMTP_FROM || 'OmniCommerce <noreply@omnicommerce.ke>';

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
