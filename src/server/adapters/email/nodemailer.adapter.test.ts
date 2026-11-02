import { describe, expect, it, vi } from 'vitest';
import { EmailSenderRejectedError, NodemailerSmtpAdapter } from './nodemailer.adapter';
import type { SenderConfig } from './sender';

const mailbox: SenderConfig = { mailbox: 'mailer@mail.test', fromName: null, policy: 'mailbox' };
const message = { to: 'buyer@customer.test', subject: 'Quotation Q-1', html: '<p>Hi</p>', sender: { name: 'Acme Ltd', address: 'sales@acme.co.ke' } };

const adapterWith = (sender: SenderConfig, sendMail = vi.fn().mockResolvedValue({ messageId: '<m1@mail.test>' })) => ({
  sendMail,
  adapter: new NodemailerSmtpAdapter({ transporter: { sendMail }, sender }),
});

describe('what the SMTP adapter hands the mail server', () => {
  it('sends as the mailbox in the business’s name, with answers to the business (servers that tie From to the login)', async () => {
    const { adapter, sendMail } = adapterWith(mailbox);
    expect(await adapter.send(message)).toEqual({ messageId: '<m1@mail.test>', provider: 'smtp' });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Acme Ltd" <mailer@mail.test>',
        replyTo: 'sales@acme.co.ke',
        envelope: { from: 'mailer@mail.test', to: 'buyer@customer.test' },
        subject: 'Quotation Q-1',
      }),
    );
    expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty('sender');
  });

  it('sends as the business with the mailbox named as the sender (servers that accept another From)', async () => {
    const { adapter, sendMail } = adapterWith({ ...mailbox, policy: 'business' });
    await adapter.send(message);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: '"Acme Ltd" <sales@acme.co.ke>', sender: 'mailer@mail.test', envelope: { from: 'mailer@mail.test', to: 'buyer@customer.test' } }),
    );
  });

  it('invents no Reply-To when the business has no real address, and keeps the configured name for mail that names no business', async () => {
    const { adapter, sendMail } = adapterWith({ ...mailbox, fromName: 'Acme Portal' });
    await adapter.send({ to: 'a@b.co', subject: 'Verify', html: '<p>x</p>', sender: { address: 'admin@localhost' } });
    const sent = sendMail.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent.from).toBe('"Acme Portal" <mailer@mail.test>');
    expect(sent.replyTo ?? null).toBeNull();
  });

  it('carries the attachments through', async () => {
    const { adapter, sendMail } = adapterWith(mailbox);
    await adapter.send({ ...message, attachments: [{ filename: 'Q-1.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }] });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ filename: 'Q-1.pdf', content: Buffer.from('pdf'), contentType: 'application/pdf' }] }));
  });
});

describe('when the mail server refuses the sender', () => {
  const refused = Object.assign(new Error('Mail command failed: 553 5.7.1 Sender address rejected: not owned by user'), { responseCode: 553, command: 'MAIL FROM', response: '553 5.7.1 Sender address rejected: not owned by user' });

  it('says so in words and what to change, naming the policy when the business address was used', async () => {
    const { adapter } = adapterWith({ ...mailbox, policy: 'business' }, vi.fn().mockRejectedValue(refused));
    const error = await adapter.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSenderRejectedError);
    expect((error as Error).message).toMatch(/refused the sender address/);
    expect((error as Error).message).toMatch(/EMAIL_FROM_POLICY=mailbox/);
    expect((error as Error).cause).toBe(refused);
  });

  it('points at the mailbox when the mailbox itself was refused', async () => {
    const { adapter } = adapterWith(mailbox, vi.fn().mockRejectedValue(refused));
    const error = await adapter.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSenderRejectedError);
    expect((error as Error).message).toContain('mailer@mail.test');
    expect((error as Error).message).toMatch(/EMAIL_FROM/);
  });

  it('leaves every other failure as it was', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
    const { adapter } = adapterWith(mailbox, vi.fn().mockRejectedValue(down));
    await expect(adapter.send(message)).rejects.toBe(down);
  });
});
