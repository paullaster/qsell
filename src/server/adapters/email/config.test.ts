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
});
