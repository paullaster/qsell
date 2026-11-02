import { describe, expect, it } from 'vitest';
import { emailRuntimeConfig } from './config';

describe('emailRuntimeConfig', () => {
  it('keeps console mode as the local default', () => {
    expect(emailRuntimeConfig({ NODE_ENV: 'development' })).toMatchObject({ driver: 'console' });
  });

  it('does not require deploy secrets during a production build', () => {
    expect(emailRuntimeConfig({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' })).toMatchObject({ driver: 'console' });
  });

  it('requires real SMTP delivery and a configured sender in production', () => {
    expect(() => emailRuntimeConfig({ NODE_ENV: 'production' })).toThrow(/EMAIL_DRIVER must be smtp/);
    expect(() => emailRuntimeConfig({ NODE_ENV: 'production', EMAIL_DRIVER: 'console' })).toThrow(/does not deliver mail/);
    expect(() => emailRuntimeConfig({ NODE_ENV: 'production', EMAIL_DRIVER: 'smtp', EMAIL_SMTP_HOST: 'smtp.example.test' })).toThrow(/EMAIL_FROM/);
    expect(emailRuntimeConfig({ NODE_ENV: 'production', EMAIL_DRIVER: 'smtp', EMAIL_SMTP_HOST: 'smtp.example.test', EMAIL_FROM: 'qsell@example.test' })).toMatchObject({ driver: 'smtp' });
  });

  describe('the sender', () => {
    const smtp = { EMAIL_DRIVER: 'smtp', EMAIL_SMTP_HOST: 'smtp.example.test' } as const;

    it('takes the mailbox from EMAIL_FROM, then SMTP_FROM (with or without a name), then a login that is an address', () => {
      expect(emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'mailer@mail.test' })).toMatchObject({ mailbox: 'mailer@mail.test', fromName: null, fromPolicy: 'mailbox' });
      expect(emailRuntimeConfig({ ...smtp, SMTP_FROM: 'Acme Ltd <mailer@mail.test>' })).toMatchObject({ mailbox: 'mailer@mail.test', fromName: 'Acme Ltd' });
      expect(emailRuntimeConfig({ ...smtp, EMAIL_SMTP_USER: 'login@mail.test' })).toMatchObject({ mailbox: 'login@mail.test' });
      expect(emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'mailer@mail.test', EMAIL_SMTP_USER: 'login@mail.test' })).toMatchObject({ mailbox: 'mailer@mail.test' });
    });

    it('takes the name from EMAIL_FROM_NAME', () => {
      expect(emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'mailer@mail.test', EMAIL_FROM_NAME: ' Acme Portal ' })).toMatchObject({ fromName: 'Acme Portal' });
    });

    it('offers two ways to put the sender in the mail and refuses any other', () => {
      expect(emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'mailer@mail.test', EMAIL_FROM_POLICY: 'business' })).toMatchObject({ fromPolicy: 'business' });
      expect(emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'mailer@mail.test', EMAIL_FROM_POLICY: ' Mailbox ' })).toMatchObject({ fromPolicy: 'mailbox' });
      expect(() => emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'mailer@mail.test', EMAIL_FROM_POLICY: 'anything' })).toThrow(/EMAIL_FROM_POLICY must be mailbox or business/);
    });

    it('has no built-in sender: SMTP without a usable mailbox or without a host is refused, in any environment', () => {
      expect(() => emailRuntimeConfig(smtp)).toThrow(/EMAIL_FROM/);
      expect(() => emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'admin@localhost' })).toThrow(/EMAIL_FROM/);
      expect(() => emailRuntimeConfig({ ...smtp, EMAIL_FROM: 'not an address' })).toThrow(/EMAIL_FROM/);
      expect(() => emailRuntimeConfig({ EMAIL_DRIVER: 'smtp', EMAIL_FROM: 'mailer@mail.test' })).toThrow(/EMAIL_SMTP_HOST/);
    });

    it('needs no sender at all for the console sink', () => {
      expect(emailRuntimeConfig({ EMAIL_DRIVER: 'console' })).toMatchObject({ driver: 'console', mailbox: null });
    });
  });
});
