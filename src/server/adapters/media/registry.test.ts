import { describe, expect, it } from 'vitest';
import { configuredMediaDriver } from './registry';

const env = (vars: Record<string, string>): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ...vars });
const production = env({ NODE_ENV: 'production' });

describe('configuredMediaDriver', () => {
  it('uses what MEDIA_DRIVER names, in any case', () => {
    expect(configuredMediaDriver(env({ MEDIA_DRIVER: 'S3' }))).toBe('s3');
    expect(configuredMediaDriver(env({ MEDIA_DRIVER: 'local' }))).toBe('local');
    expect(configuredMediaDriver(env({ MEDIA_DRIVER: 'cloudinary' }))).toBe('cloudinary');
  });

  it('defaults to S3-compatible storage whenever a bucket is configured, in production too', () => {
    expect(configuredMediaDriver({ ...production, S3_BUCKET: 'qsell-assets' })).toBe('s3');
    expect(configuredMediaDriver(env({ S3_BUCKET: 'qsell-assets' }))).toBe('s3');
  });

  it('falls back to local disk only in development, and insists on a choice in production', () => {
    expect(configuredMediaDriver(env({}))).toBe('local');
    expect(() => configuredMediaDriver(production)).toThrow(
      'MEDIA_DRIVER must be set in production',
    );
  });

  it('refuses a driver it does not know, and lists the ones it does', () => {
    expect(() => configuredMediaDriver(env({ MEDIA_DRIVER: 'ftp' }))).toThrow(
      'Use "s3", "local" or "cloudinary"',
    );
  });
});
