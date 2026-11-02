import nodemailer from 'nodemailer';
import type { EmailMessage, EmailPort, EmailSendResult } from '@/server/ports/communications';
import { isRecord } from '@/lib/values';
import { emailRuntimeConfig } from './config';
import { resolveSender, type SenderConfig } from './sender';

export class ConsoleEmailAdapter implements EmailPort {
  readonly name = 'console';

  send(message: EmailMessage): Promise<EmailSendResult> {
    const id = `console_${Date.now()}`;
    console.warn('[ConsoleEmailAdapter] Outbound email', {
      id,
      to: message.to.replace(/^(.).+(@.+)$/, '$1…$2'),
      subject: message.subject,
      provider: this.name,
      delivery: 'not_sent',
    });
    return Promise.resolve({ messageId: id, provider: this.name });
  }
}

/** First value that is set and not blank; env vars are often present but empty. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.find((value): value is string => value !== undefined && value.trim() !== '');
}

/**
 * The mail server would not take the sender. Said in words, with what to change, because the server's own reply
 * ("553 5.7.1 ...") means nothing to the person who pressed Send.
 */
export class EmailSenderRejectedError extends Error {
  constructor(message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'EmailSenderRejectedError';
  }
}

interface SmtpFailure {
  command?: unknown;
  responseCode?: unknown;
  response?: unknown;
}

/** A refusal of the MAIL FROM address, as the server words it; connection and delivery problems are not this. */
function refusedSender(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const failure: SmtpFailure = error;
  if (failure.command === 'MAIL FROM') return true;
  const code = typeof failure.responseCode === 'number' ? failure.responseCode : 0;
  const response = typeof failure.response === 'string' ? failure.response : '';
  return [501, 550, 553, 554].includes(code) && /sender|from address|not owned|spoof|not permitted|not allowed to send|authenticated user/i.test(response);
}

type Sendable = Pick<nodemailer.Transporter, 'sendMail'>;

export class NodemailerSmtpAdapter implements EmailPort {
  readonly name = 'smtp';
  private readonly transporter: Sendable;
  private readonly sender: SenderConfig;

  /**
   * Everything comes from the deployment's settings (see config.ts); there is no built-in host, address or name. The options are for
   * tests and for a caller that has its own settings.
   */
  constructor(options?: { transporter?: Sendable; sender?: SenderConfig; host?: string; port?: number; user?: string; pass?: string; secure?: boolean }) {
    if (options?.sender !== undefined) {
      this.sender = options.sender;
    } else {
      const config = emailRuntimeConfig(process.env);
      if (config.mailbox === null) throw new Error('SMTP needs EMAIL_FROM set to the mailbox address the mail server lets this instance send as.');
      this.sender = { mailbox: config.mailbox, fromName: config.fromName, policy: config.fromPolicy };
    }
    if (options?.transporter !== undefined) {
      this.transporter = options.transporter;
      return;
    }
    // Accept both SMTP_* and the EMAIL_SMTP_* names documented in .env.example.
    const env = process.env;
    const host = firstNonEmpty(options?.host, env.SMTP_HOST, env.EMAIL_SMTP_HOST);
    if (host === undefined) throw new Error('SMTP needs EMAIL_SMTP_HOST (or SMTP_HOST): there is no built-in mail server.');
    const port = options?.port ?? Number(firstNonEmpty(env.SMTP_PORT, env.EMAIL_SMTP_PORT) ?? 587);
    const user = firstNonEmpty(options?.user, env.SMTP_USER, env.EMAIL_SMTP_USER) ?? '';
    const pass = firstNonEmpty(options?.pass, env.SMTP_PASS, env.EMAIL_SMTP_PASSWORD) ?? '';
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: options?.secure ?? port === 465,
      auth: user !== '' ? { user, pass } : undefined,
    });
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const resolved = resolveSender(this.sender, message);
    let info: unknown;
    try {
      info = await this.transporter.sendMail({
        from: resolved.from,
        ...(resolved.sender === null ? {} : { sender: resolved.sender }),
        ...(resolved.replyTo === null ? {} : { replyTo: resolved.replyTo }),
        envelope: { from: resolved.envelopeFrom, to: message.to },
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
    } catch (error: unknown) {
      if (!refusedSender(error)) throw error;
      throw new EmailSenderRejectedError(
        this.sender.policy === 'business'
          ? 'The mail server refused the sender address. This instance sends from the business address (EMAIL_FROM_POLICY=business); set EMAIL_FROM_POLICY=mailbox so mail goes out from the mailbox the server allows, then try again.'
          : `The mail server refused the sender address ${this.sender.mailbox}. Set EMAIL_FROM to an address this mail server lets the login send as (usually the login itself), then try again.`,
        { cause: error },
      );
    }

    const messageId = isRecord(info) && typeof info.messageId === 'string' && info.messageId !== ''
      ? info.messageId
      : `smtp_${Date.now()}`;
    return {
      messageId,
      provider: this.name,
    };
  }
}
