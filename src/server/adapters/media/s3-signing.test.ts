import { describe, expect, it } from 'vitest';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { presignGetUrl } from './s3-signing';

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const NOW = new Date('2026-10-26T09:30:15Z');

/** The SDK's own answer for the same request: the standard to match. */
async function sdkUrl(
  endpoint: string,
  region: string,
  pathStyle: boolean,
  bucket: string,
  key: string,
  expiresIn: number,
): Promise<URL> {
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: pathStyle,
    credentials: CREDENTIALS,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return new URL(
    await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn,
      signingDate: NOW,
    }),
  );
}

const pairs = (url: URL): [string, string][] =>
  [...url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

const KEYS = [
  'qsell/private/vendor/3f2b9c1e-aaaa-4bbb-8ccc-0123456789ab.png',
  "qsell/private/ev idence/with space & symbols (1)!*'.jpg",
  'qsell/public/product/ünïcode-naïve.webp',
];

describe('presignGetUrl matches the AWS SDK', () => {
  for (const key of KEYS) {
    it(`path-style on a local store: ${key}`, async () => {
      const mine = new URL(
        presignGetUrl({
          endpoint: new URL('http://127.0.0.1:9000'),
          bucket: 'media',
          region: 'us-east-1',
          key,
          ...CREDENTIALS,
          pathStyle: true,
          expiresInSeconds: 300,
          now: NOW,
        }),
      );
      const theirs = await sdkUrl('http://127.0.0.1:9000', 'us-east-1', true, 'media', key, 300);
      expect(mine.origin).toBe(theirs.origin);
      expect(mine.pathname).toBe(theirs.pathname);
      expect(pairs(mine)).toEqual(pairs(theirs));
    });

    it(`virtual-hosted on AWS: ${key}`, async () => {
      const mine = new URL(
        presignGetUrl({
          endpoint: new URL('https://s3.eu-west-1.amazonaws.com'),
          bucket: 'qsell-assets',
          region: 'eu-west-1',
          key,
          ...CREDENTIALS,
          pathStyle: false,
          expiresInSeconds: 3600,
          now: NOW,
        }),
      );
      const theirs = await sdkUrl(
        'https://s3.eu-west-1.amazonaws.com',
        'eu-west-1',
        false,
        'qsell-assets',
        key,
        3600,
      );
      expect(mine.origin).toBe('https://qsell-assets.s3.eu-west-1.amazonaws.com');
      expect(mine.origin).toBe(theirs.origin);
      expect(mine.pathname).toBe(theirs.pathname);
      expect(pairs(mine)).toEqual(pairs(theirs));
    });
  }

  it('keeps a non-default port in the signed host', async () => {
    const mine = new URL(
      presignGetUrl({
        endpoint: new URL('https://store.example.test:8443'),
        bucket: 'media',
        region: 'auto',
        key: 'a/b.png',
        ...CREDENTIALS,
        pathStyle: true,
        expiresInSeconds: 60,
        now: NOW,
      }),
    );
    const theirs = await sdkUrl(
      'https://store.example.test:8443',
      'auto',
      true,
      'media',
      'a/b.png',
      60,
    );
    expect(pairs(mine)).toEqual(pairs(theirs));
  });

  it('changes when the time, the key or the secret changes', () => {
    const base = {
      endpoint: new URL('http://127.0.0.1:9000'),
      bucket: 'media',
      region: 'us-east-1',
      key: 'a.png',
      ...CREDENTIALS,
      pathStyle: true,
      expiresInSeconds: 300,
      now: NOW,
    };
    const url = presignGetUrl(base);
    expect(presignGetUrl({ ...base, now: new Date(NOW.getTime() + 1000) })).not.toBe(url);
    expect(presignGetUrl({ ...base, key: 'b.png' })).not.toBe(url);
    expect(presignGetUrl({ ...base, secretAccessKey: 'other' })).not.toBe(url);
    expect(url).not.toContain(CREDENTIALS.secretAccessKey);
  });
});
