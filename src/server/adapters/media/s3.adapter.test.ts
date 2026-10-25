import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nth } from '@/lib/values';
import {
  S3MediaAdapter,
  S3MediaError,
  isSafeStorageKey,
  s3ConfigFromEnv,
  type S3AdapterConfig,
} from './s3.adapter';

const ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  S3_BUCKET: 'qsell-assets',
  S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('s3ConfigFromEnv', () => {
  it('uses AWS defaults: the regional endpoint, virtual-hosted style, the qsell folder', () => {
    const config = s3ConfigFromEnv({ ...ENV, S3_REGION: 'eu-west-1' });
    expect(config.endpoint.href).toBe('https://s3.eu-west-1.amazonaws.com/');
    expect(config).toMatchObject({
      region: 'eu-west-1',
      bucket: 'qsell-assets',
      forcePathStyle: false,
      prefix: 'qsell',
      publicBaseUrl: null,
      encryption: null,
      attempts: 3,
    });
  });

  it('treats a custom endpoint as path-style unless told otherwise, and reads the optional settings', () => {
    const minio = s3ConfigFromEnv({
      ...ENV,
      S3_ENDPOINT: 'http://127.0.0.1:9000',
      S3_PREFIX: '/shop/prod/',
      S3_PUBLIC_URL: 'https://cdn.example.test/m',
      S3_SSE: 'AES256',
      S3_ATTEMPTS: '5',
    });
    expect(minio).toMatchObject({
      forcePathStyle: true,
      prefix: 'shop/prod',
      encryption: 'AES256',
      attempts: 5,
    });
    expect(minio.publicBaseUrl?.href).toBe('https://cdn.example.test/m');
    expect(
      s3ConfigFromEnv({
        ...ENV,
        S3_ENDPOINT: 'https://objects.example.test',
        S3_FORCE_PATH_STYLE: 'false',
      }).forcePathStyle,
    ).toBe(false);
  });

  it('refuses incomplete or unsafe settings, saying which one and never echoing a value', () => {
    expect(() => s3ConfigFromEnv({ NODE_ENV: 'test' })).toThrow(
      'S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY',
    );
    expect(() => s3ConfigFromEnv({ ...ENV, S3_BUCKET: 'Bad_Bucket' })).toThrow(
      'S3_BUCKET is not a valid bucket name',
    );
    expect(() => s3ConfigFromEnv({ ...ENV, S3_PREFIX: '../x' })).toThrow('S3_PREFIX');
    expect(() => s3ConfigFromEnv({ ...ENV, S3_SSE: 'rot13' })).toThrow('S3_SSE');
    expect(() => s3ConfigFromEnv({ ...ENV, S3_ENDPOINT: 'ftp://x.test' })).toThrow('S3_ENDPOINT');
    expect(() => s3ConfigFromEnv({ ...ENV, S3_ENDPOINT: 'https://user:pass@x.test' })).toThrow(
      'user name or password',
    );
    expect(() =>
      s3ConfigFromEnv({ ...ENV, NODE_ENV: 'production', S3_ENDPOINT: 'http://insecure.test' }),
    ).toThrow('https://');
    try {
      s3ConfigFromEnv({ ...ENV, S3_BUCKET: 'Bad_Bucket' });
    } catch (error) {
      expect(String(error)).not.toContain(ENV.S3_SECRET_ACCESS_KEY);
    }
  });
});

describe('isSafeStorageKey', () => {
  it('accepts keys the app made and nothing that climbs out of its folder', () => {
    expect(isSafeStorageKey('qsell/public/product/3f2b9c1e-aaaa.png')).toBe(true);
    for (const bad of ['', '/etc/passwd', 'a/../b', 'a//b', './a', 'a b.png', 'a?x=1'])
      expect(isSafeStorageKey(bad)).toBe(false);
  });
});

function adapter(
  over: Partial<S3AdapterConfig> = {},
  clock = () => new Date('2026-10-26T09:30:15Z'),
): S3MediaAdapter {
  return new S3MediaAdapter(
    { ...s3ConfigFromEnv({ ...ENV, S3_ENDPOINT: 'http://127.0.0.1:9000' }), ...over },
    clock,
  );
}

describe('urlFor', () => {
  it('serves a public file from the public base URL, whatever the trailing slash', () => {
    const url = adapter({ publicBaseUrl: new URL('https://cdn.example.test/media/') }).urlFor({
      storageKey: 'qsell/public/product/a.png',
      visibility: 'public',
    });
    expect(url).toBe('https://cdn.example.test/media/qsell/public/product/a.png');
  });

  it('signs a private file for five minutes by default and never longer than an hour', () => {
    const port = adapter();
    const ref = { storageKey: 'qsell/private/vendor/x.png', visibility: 'private' as const };
    expect(new URL(port.urlFor(ref)).searchParams.get('X-Amz-Expires')).toBe('300');
    expect(
      new URL(port.urlFor(ref, { expiresInSeconds: 999_999 })).searchParams.get('X-Amz-Expires'),
    ).toBe('3600');
    expect(
      new URL(port.urlFor(ref, { expiresInSeconds: 0 })).searchParams.get('X-Amz-Expires'),
    ).toBe('1');
    expect(port.urlFor(ref)).not.toContain(ENV.S3_SECRET_ACCESS_KEY);
  });

  it('without a public base URL, a public file gets a signed link that stays the same within a window', () => {
    const ref = { storageKey: 'qsell/public/product/x.png', visibility: 'public' as const };
    const early = adapter({}, () => new Date('2026-10-26T06:10:00Z')).urlFor(ref);
    const sameWindow = adapter({}, () => new Date('2026-10-26T11:59:00Z')).urlFor(ref);
    const nextWindow = adapter({}, () => new Date('2026-10-26T12:01:00Z')).urlFor(ref);
    expect(sameWindow).toBe(early);
    expect(nextWindow).not.toBe(early);
    expect(new URL(early).searchParams.get('X-Amz-Expires')).toBe('86400');
  });

  it('refuses a key that could escape the folder', () => {
    expect(() => adapter().urlFor({ storageKey: '../secret', visibility: 'private' })).toThrow(
      S3MediaError,
    );
  });
});

describe('delete and errors (with the store stubbed)', () => {
  const stub = (send: () => Promise<unknown>) => ({ send }) as unknown as S3Client;
  const config = (): S3AdapterConfig =>
    s3ConfigFromEnv({ ...ENV, S3_ENDPOINT: 'http://127.0.0.1:9000' });
  const failure = (status: number, name: string) =>
    new S3ServiceException({
      name,
      $fault: 'client',
      $metadata: { httpStatusCode: status },
      message: 'secret-bucket details',
    });

  it('treats a file that is already gone as deleted', async () => {
    await expect(
      new S3MediaAdapter(
        config(),
        undefined,
        stub(() => Promise.reject(failure(404, 'NoSuchKey'))),
      ).delete({ storageKey: 'qsell/public/x.png', visibility: 'public' }),
    ).resolves.toBeUndefined();
  });

  it('does nothing for a key that is not its own', async () => {
    const send = vi.fn();
    await new S3MediaAdapter(config(), undefined, stub(send)).delete({
      storageKey: '../x',
      visibility: 'public',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('explains a refusal in plain words without the store’s own message', async () => {
    const port = new S3MediaAdapter(
      config(),
      undefined,
      stub(() => Promise.reject(failure(403, 'AccessDenied'))),
    );
    const error = await port
      .put({ data: PNG, mime: 'image/png', folder: 'product', visibility: 'public' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3MediaError);
    expect(String(error)).toContain('access was refused');
    expect(String(error)).not.toContain('secret-bucket');
  });

  it('refuses a file type it does not store', async () => {
    await expect(
      adapter().put({ data: PNG, mime: 'image/svg+xml', folder: 'product', visibility: 'public' }),
    ).rejects.toThrow('Unsupported media type');
  });
});

// A small S3 of our own: the real SDK talks to it over HTTP, and downloads are accepted only with a link the SDK itself would sign.
describe('against an S3-compatible server', () => {
  const objects = new Map<string, { body: Buffer; headers: IncomingMessage['headers'] }>();
  let server: Server;
  let endpoint = '';

  const bodyOf = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    server = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', endpoint);
        const key = decodeURIComponent(url.pathname).replace(/^\/qsell-assets\//, '');
        if (req.method === 'PUT') {
          if (
            !String(req.headers.authorization).startsWith(
              'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/',
            )
          ) {
            res.writeHead(403).end();
            return;
          }
          objects.set(key, { body: await bodyOf(req), headers: req.headers });
          res.writeHead(200, { ETag: '"x"' }).end();
          return;
        }
        if (req.method === 'DELETE') {
          objects.delete(key);
          res.writeHead(204).end();
          return;
        }
        if (req.method === 'GET') {
          const date = url.searchParams.get('X-Amz-Date') ?? '';
          if (!/^\d{8}T\d{6}Z$/.test(date)) {
            res.writeHead(403).end();
            return;
          }
          const signed = new Date(
            `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
          );
          const expires = Number(url.searchParams.get('X-Amz-Expires'));
          const fresh = Date.now() < signed.getTime() + expires * 1000;
          const expected = new URL(
            await getSignedUrl(
              new S3Client({
                region: 'us-east-1',
                endpoint,
                forcePathStyle: true,
                credentials: {
                  accessKeyId: 'AKIDEXAMPLE',
                  secretAccessKey: ENV.S3_SECRET_ACCESS_KEY ?? '',
                },
                requestChecksumCalculation: 'WHEN_REQUIRED',
                responseChecksumValidation: 'WHEN_REQUIRED',
              }),
              new GetObjectCommand({ Bucket: 'qsell-assets', Key: key }),
              { expiresIn: expires, signingDate: signed },
            ),
          );
          const object = objects.get(key);
          if (
            !fresh ||
            expected.searchParams.get('X-Amz-Signature') !== url.searchParams.get('X-Amz-Signature')
          ) {
            res.writeHead(403).end();
          } else if (object === undefined) {
            res.writeHead(404).end();
          } else {
            res
              .writeHead(200, { 'Content-Type': String(object.headers['content-type']) })
              .end(object.body);
          }
          return;
        }
        res.writeHead(405).end();
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(() => {
    server.close();
  });

  const live = () =>
    new S3MediaAdapter(s3ConfigFromEnv({ ...ENV, S3_ENDPOINT: endpoint, S3_ATTEMPTS: '1' }));

  it('uploads with the right type and caching, reads back through a signed link, refuses a bad link, and deletes', async () => {
    const port = live();
    const stored = await port.put({
      data: PNG,
      mime: 'image/png',
      folder: 'vendor docs',
      visibility: 'private',
    });
    expect(stored.bytes).toBe(PNG.byteLength);
    expect(stored.storageKey).toMatch(/^qsell\/private\/vendordocs\/[0-9a-f-]{36}\.png$/);

    const saved = objects.get(stored.storageKey);
    expect(saved?.body.equals(PNG)).toBe(true);
    expect(saved?.headers['content-type']).toBe('image/png');
    expect(saved?.headers['cache-control']).toBe('private, no-store');

    const ref = { storageKey: stored.storageKey, visibility: 'private' as const };
    const good = await fetch(port.urlFor(ref));
    expect(good.status).toBe(200);
    expect(Buffer.from(await good.arrayBuffer()).equals(PNG)).toBe(true);

    const tampered = new URL(port.urlFor(ref));
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    expect((await fetch(tampered)).status).toBe(403);
    expect((await fetch(`${endpoint}/qsell-assets/${stored.storageKey}`)).status).toBe(403);

    await port.delete(ref);
    expect(objects.has(stored.storageKey)).toBe(false);
    await expect(port.delete(ref)).resolves.toBeUndefined();
  });

  it('gives a public file a long cache and a different name every time', async () => {
    const port = live();
    const a = await port.put({
      data: PNG,
      mime: 'image/png',
      folder: 'product',
      visibility: 'public',
    });
    const b = await port.put({
      data: PNG,
      mime: 'image/png',
      folder: 'product',
      visibility: 'public',
    });
    expect(a.storageKey).not.toBe(b.storageKey);
    expect(objects.get(a.storageKey)?.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(nth([a, b], 0).storageKey).toContain('/public/product/');
  });

  it('says plainly when the store cannot be reached, without a raw network message', async () => {
    const down = new S3MediaAdapter(
      s3ConfigFromEnv({
        ...ENV,
        S3_ENDPOINT: 'http://127.0.0.1:1',
        S3_ATTEMPTS: '1',
        S3_TIMEOUT_MS: '1000',
      }),
    );
    const error = await down
      .put({ data: PNG, mime: 'image/png', folder: 'product', visibility: 'public' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3MediaError);
    expect(String(error)).toContain('could not be reached');
  });
});
