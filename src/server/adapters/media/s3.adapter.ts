import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { has, orElse } from '@/lib/values';
import type {
  MediaObjectRef,
  MediaStoragePort,
  MediaUrlOptions,
  PutMediaInput,
  PutMediaResult,
} from '@/server/ports/media';
import { objectPath, presignGetUrl } from './s3-signing';

/** What the app may store: the file types its own checks accept. */
const EXTENSIONS: Partial<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

export const DEFAULT_PRIVATE_URL_TTL_SECONDS = 300;
const MAX_PRIVATE_URL_TTL_SECONDS = 3600;
/** Without a public base URL a public file gets a signed link that stays the same within this window, so browsers can cache it. */
const PUBLIC_FALLBACK_WINDOW_SECONDS = 6 * 3600;
const PUBLIC_FALLBACK_TTL_SECONDS = 24 * 3600;

export interface S3AdapterConfig {
  /** Service endpoint the server talks to. For AWS, derived from the region. */
  endpoint: URL;
  /**
   * The address browsers use in signed links. The same as `endpoint` unless the store sits on a private
   * network and is reached from outside through a proxy (then the proxy must pass the Host header unchanged).
   */
  signingEndpoint: URL;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style (`host/bucket/key`) for MinIO and most S3-compatible stores; virtual-hosted for AWS. */
  forcePathStyle: boolean;
  /** Folder inside the bucket, so several apps or environments can share one. */
  prefix: string;
  /** Base URL that serves public files (a CDN or a public bucket); without it public files get signed links. */
  publicBaseUrl: URL | null;
  /** Server-side encryption to ask for: AES256, or aws:kms. Left off when the store does not support it. */
  encryption: 'AES256' | 'aws:kms' | null;
  timeoutMs: number;
  attempts: number;
}

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;
const REGION_PATTERN = /^[a-z0-9-]{2,30}$/i;

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** A name only the private network knows (`rustfs`, `localhost`): plain http is safe there, nothing crosses the internet. */
function isInternalHost(hostname: string): boolean {
  return (
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

function parsedUrl(name: string, value: string, production: boolean, internalOk = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  const plain =
    url.protocol === 'http:' && (!production || (internalOk && isInternalHost(url.hostname)));
  if (url.protocol !== 'https:' && !plain) {
    const allowed = internalOk
      ? ' (http:// is allowed only for a name on the private network, such as http://rustfs:9000)'
      : '';
    throw new Error(
      `${name} must be an https:// address${production ? allowed : ' (http:// is allowed outside production, for a local store)'}.`,
    );
  }
  if (url.username !== '' || url.password !== '')
    throw new Error(`${name} must not carry a user name or password.`);
  return url;
}

/**
 * The `S3_*` settings. Error messages name the setting that is wrong and never echo a value, so a
 * secret cannot reach a log. Works with AWS S3 and any S3-compatible store (MinIO, Cloudflare R2,
 * Backblaze B2, Wasabi, DigitalOcean Spaces).
 */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3AdapterConfig {
  const production = env.NODE_ENV === 'production';
  const bucket = env.S3_BUCKET?.trim() ?? '';
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim() ?? '';
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim() ?? '';
  if (!has(bucket) || !has(accessKeyId) || !has(secretAccessKey)) {
    throw new Error('MEDIA_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.');
  }
  if (!BUCKET_PATTERN.test(bucket) || bucket.includes('..')) {
    throw new Error(
      'S3_BUCKET is not a valid bucket name (3–63 lower-case letters, numbers, "-" and ".").',
    );
  }
  const region = orElse(env.S3_REGION?.trim(), 'us-east-1');
  if (!REGION_PATTERN.test(region)) throw new Error('S3_REGION is not a valid region name.');

  const rawEndpoint = env.S3_ENDPOINT?.trim() ?? '';
  const custom = has(rawEndpoint) && !/\.amazonaws\.com(\.cn)?\/?$/i.test(rawEndpoint);
  const endpoint = parsedUrl(
    'S3_ENDPOINT',
    has(rawEndpoint) ? rawEndpoint : `https://s3.${region}.amazonaws.com`,
    production,
    true,
  );
  const rawSigning = env.S3_PUBLIC_ENDPOINT?.trim() ?? '';
  const signingEndpoint = has(rawSigning)
    ? parsedUrl('S3_PUBLIC_ENDPOINT', rawSigning, production)
    : endpoint;

  const prefix = (env.S3_PREFIX ?? 'qsell').replace(/^\/+|\/+$/g, '');
  if (prefix !== '' && !PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      'S3_PREFIX may only contain letters, numbers, "-", "_" and "/" between segments.',
    );
  }

  const rawPublic = env.S3_PUBLIC_URL?.trim() ?? '';
  const sse = env.S3_SSE?.trim() ?? '';
  if (has(sse) && sse !== 'AES256' && sse !== 'aws:kms')
    throw new Error('S3_SSE must be AES256 or aws:kms.');

  const style = (env.S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase();
  return {
    endpoint,
    signingEndpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: style === 'true' || (style !== 'false' && custom),
    prefix,
    publicBaseUrl: has(rawPublic) ? parsedUrl('S3_PUBLIC_URL', rawPublic, production) : null,
    encryption: has(sse) ? sse : null,
    timeoutMs: boundedInt(env.S3_TIMEOUT_MS, 30_000, 1_000, 120_000),
    attempts: boundedInt(env.S3_ATTEMPTS, 3, 1, 5),
  };
}

/** A failed S3 call without the store's raw reply, which can name buckets and keys. */
export class S3MediaError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly httpCode: number | undefined,
  ) {
    super(
      `S3 ${operation} failed${httpCode === undefined ? '' : ` (HTTP ${String(httpCode)})`}: ${message}`,
    );
    this.name = 'S3MediaError';
  }
}

function reasonFor(error: S3ServiceException): string {
  const code = error.$metadata.httpStatusCode;
  if (code === 403) return 'access was refused: check the key, the bucket policy and the clock';
  if (code === 404) return 'the bucket was not found';
  return error.name;
}

function explain(operation: string, error: unknown): S3MediaError {
  if (error instanceof S3ServiceException) {
    return new S3MediaError(operation, reasonFor(error), error.$metadata.httpStatusCode);
  }
  const code = error instanceof Error ? error.name : 'error';
  return new S3MediaError(operation, `${code} (the store could not be reached)`, undefined);
}

/** A storage key the app made itself: no way out of the folder, no odd characters. */
export function isSafeStorageKey(key: string): boolean {
  return (
    key !== '' &&
    !key.startsWith('/') &&
    !key.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    /^[A-Za-z0-9._\-/]+$/.test(key)
  );
}

/**
 * Stores files in an S3-compatible bucket. Public files are served from `S3_PUBLIC_URL` (a CDN or a
 * public bucket) and private files by short-lived signed links, handed out only after an access check.
 * Sizes are not generated: images are resized at request time by `next/image`.
 */
export class S3MediaAdapter implements MediaStoragePort {
  readonly provider = 's3' as const;
  private readonly client: S3Client;

  constructor(
    private readonly config: S3AdapterConfig = s3ConfigFromEnv(),
    private readonly clock: () => Date = () => new Date(),
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint.origin,
        forcePathStyle: config.forcePathStyle,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        maxAttempts: config.attempts,
        // Third-party stores reject the SDK's default extra checksums; ask for them only where required.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
        requestHandler: { connectionTimeout: config.timeoutMs, requestTimeout: config.timeoutMs },
      });
  }

  async put(input: PutMediaInput): Promise<PutMediaResult> {
    const extension = EXTENSIONS[input.mime];
    if (extension === undefined) throw new Error(`Unsupported media type: ${input.mime}`);
    const cleaned = input.folder.replace(/[^a-z0-9_-]/gi, '');
    const folder = cleaned === '' ? 'misc' : cleaned;
    const root = this.config.prefix === '' ? '' : `${this.config.prefix}/`;
    const storageKey = `${root}${input.visibility}/${folder}/${randomUUID()}.${extension}`;
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: storageKey,
          Body: input.data,
          ContentType: input.mime,
          ContentLength: input.data.byteLength,
          CacheControl:
            input.visibility === 'public'
              ? 'public, max-age=31536000, immutable'
              : 'private, no-store',
          // A file the browser opens must be shown, never run, whatever it claims to be.
          ContentDisposition: 'inline',
          ...(this.config.encryption === null
            ? {}
            : { ServerSideEncryption: this.config.encryption }),
        }),
      );
    } catch (error) {
      throw explain('upload', error);
    }
    return { storageKey, bytes: input.data.byteLength };
  }

  async delete(ref: MediaObjectRef): Promise<void> {
    if (!isSafeStorageKey(ref.storageKey)) return;
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: ref.storageKey }),
      );
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return;
      throw explain('delete', error);
    }
  }

  urlFor(ref: MediaObjectRef, options: MediaUrlOptions = {}): string {
    if (!isSafeStorageKey(ref.storageKey))
      throw new S3MediaError('url', 'the storage key is not valid', undefined);
    if (ref.visibility === 'public' && this.config.publicBaseUrl !== null) {
      const base = this.config.publicBaseUrl.href.replace(/\/+$/, '');
      return `${base}/${ref.storageKey.split('/').map(encodeURIComponent).join('/')}`;
    }
    const now = this.clock();
    if (ref.visibility === 'public') {
      const windowMs = PUBLIC_FALLBACK_WINDOW_SECONDS * 1000;
      return this.sign(
        ref.storageKey,
        PUBLIC_FALLBACK_TTL_SECONDS,
        new Date(Math.floor(now.getTime() / windowMs) * windowMs),
      );
    }
    const ttl = Math.min(
      Math.max(Math.trunc(options.expiresInSeconds ?? DEFAULT_PRIVATE_URL_TTL_SECONDS), 1),
      MAX_PRIVATE_URL_TTL_SECONDS,
    );
    return this.sign(ref.storageKey, ttl, now);
  }

  /** Whether `path` would be the object's path in this configuration (used by the smoke check). */
  objectPathFor(key: string): string {
    return objectPath(this.config.bucket, key, this.config.forcePathStyle);
  }

  private sign(key: string, expiresInSeconds: number, at: Date): string {
    return presignGetUrl({
      endpoint: this.config.signingEndpoint,
      bucket: this.config.bucket,
      region: this.config.region,
      key,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      pathStyle: this.config.forcePathStyle,
      expiresInSeconds,
      now: at,
    });
  }
}
