import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import type {
  MediaObjectRef,
  MediaStoragePort,
  MediaUrlOptions,
  MediaVariant,
  MediaVisibility,
  PutMediaInput,
  PutMediaResult,
} from '@/server/ports/media';

/** Delivery transformations per variant. Originals are served untouched. */
const VARIANTS: Record<Exclude<MediaVariant, 'original'>, Record<string, unknown>> = {
  thumb: {
    width: 160,
    height: 160,
    crop: 'fill',
    gravity: 'auto',
    quality: 'auto',
    fetch_format: 'auto',
  },
  card: { width: 600, crop: 'limit', quality: 'auto', fetch_format: 'auto' },
  detail: { width: 1200, crop: 'limit', quality: 'auto', fetch_format: 'auto' },
};

/** Cloudinary's name for each MIME type we accept. Also the provider-side upload allow-list. */
const FORMAT_BY_MIME: Partial<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
const ALLOWED_FORMATS = [...new Set(Object.values(FORMAT_BY_MIME))] as string[];

type DeliveryKind = 'upload' | 'private' | 'authenticated';

/** What Cloudinary reports as an asset's delivery type. */
function deliveryType(visibility: MediaVisibility): 'upload' | 'authenticated' {
  return visibility === 'private' ? 'authenticated' : 'upload';
}

export const DEFAULT_PRIVATE_URL_TTL_SECONDS = 300;
const MAX_PRIVATE_URL_TTL_SECONDS = 3600;

export interface CloudinaryAdapterConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  /** Root folder inside the account, so several apps/environments can share one. */
  folder: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Total tries for one operation (first attempt included). */
  attempts: number;
  /** First retry delay; doubles each time, with jitter. */
  retryBaseDelayMs: number;
}

const CLOUD_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const FOLDER_PATTERN = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i;

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * `CLOUDINARY_URL` (cloudinary://key:secret@cloud) or the three discrete variables.
 * Error messages name the setting that is wrong and never echo a value.
 */
export function cloudinaryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CloudinaryAdapterConfig {
  const folder = (env.CLOUDINARY_FOLDER ?? 'qsell').replace(/^\/+|\/+$/g, '');
  if (!FOLDER_PATTERN.test(folder)) {
    throw new Error(
      'CLOUDINARY_FOLDER may only contain letters, numbers, "-", "_" and "/" between segments.',
    );
  }

  let cloudName: string | undefined;
  let apiKey: string | undefined;
  let apiSecret: string | undefined;
  if (present(env.CLOUDINARY_URL)) {
    try {
      const url = new URL(env.CLOUDINARY_URL);
      if (url.protocol === 'cloudinary:') {
        cloudName = url.hostname;
        apiKey = decodeURIComponent(url.username);
        apiSecret = decodeURIComponent(url.password);
      }
    } catch {
      throw new Error('CLOUDINARY_URL is not a valid URL. Expected cloudinary://API_KEY:API_SECRET@CLOUD_NAME.');
    }
  }
  cloudName ??= env.CLOUDINARY_CLOUD_NAME;
  apiKey = present(apiKey) ? apiKey : env.CLOUDINARY_API_KEY;
  apiSecret = present(apiSecret) ? apiSecret : env.CLOUDINARY_API_SECRET;

  if (!present(cloudName) || !present(apiKey) || !present(apiSecret)) {
    throw new Error(
      'MEDIA_DRIVER=cloudinary needs CLOUDINARY_URL, or CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET.',
    );
  }
  if (!CLOUD_NAME_PATTERN.test(cloudName)) {
    throw new Error('The Cloudinary cloud name may only contain letters, numbers, "-" and "_".');
  }

  return {
    cloudName,
    apiKey,
    apiSecret,
    folder,
    timeoutMs: boundedInt(env.CLOUDINARY_TIMEOUT_MS, 30_000, 1_000, 120_000),
    attempts: boundedInt(env.CLOUDINARY_ATTEMPTS, 3, 1, 5),
    retryBaseDelayMs: boundedInt(env.CLOUDINARY_RETRY_BASE_MS, 250, 0, 5_000),
  };
}

/**
 * A failed Cloudinary call, with enough structure to decide whether to retry and
 * what to log. The SDK rejects with plain `{ message, http_code }` objects, not
 * Errors, so everything is normalised through here.
 */
export class CloudinaryError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly httpCode: number | undefined,
    readonly retryable: boolean,
  ) {
    super(`Cloudinary ${operation} failed${httpCode === undefined ? '' : ` (HTTP ${httpCode})`}: ${message}`);
    this.name = 'CloudinaryError';
  }

  /** 401/403: the account settings are wrong, which no amount of retrying fixes. */
  get isCredentialProblem(): boolean {
    return this.httpCode === 401 || this.httpCode === 403;
  }
}

/** 420 is Cloudinary's rate-limit status; 499 is how the SDK reports its own request timeout. */
const RETRYABLE_HTTP_CODES = new Set([420, 429, 499]);

function toCloudinaryError(operation: string, raw: unknown): CloudinaryError {
  if (raw instanceof CloudinaryError) return raw;
  const fields = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    message?: unknown;
    http_code?: unknown;
  };
  const message = typeof fields.message === 'string' && fields.message !== '' ? fields.message : 'unknown error';
  const httpCode = typeof fields.http_code === 'number' ? fields.http_code : undefined;
  // No HTTP status means the request never completed (reset, DNS, TLS): worth another try.
  const retryable = httpCode === undefined || httpCode >= 500 || RETRYABLE_HTTP_CODES.has(httpCode);
  return new CloudinaryError(operation, message, httpCode, retryable);
}

/**
 * Cloudinary storage. Public assets use delivery type `upload`; private assets
 * use `authenticated`, which Cloudinary will not serve without a signature.
 *
 * Private files are handed out as time-limited download URLs (served as the
 * original; the token expires, so a leaked URL stops working). That is stronger
 * than a signed `authenticated` delivery URL, which never expires unless the
 * account has token authentication.
 *
 * Uploads use a fixed `public_id` with `overwrite: false`, so retrying after a
 * lost response cannot create a duplicate: Cloudinary returns the existing asset.
 */
export class CloudinaryMediaAdapter implements MediaStoragePort {
  readonly provider = 'cloudinary' as const;

  constructor(private readonly config: CloudinaryAdapterConfig = cloudinaryConfigFromEnv()) {
    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
      secure: true,
      // Keep delivery URLs clean and cache-friendly: no SDK-version tracking query string.
      analytics: false,
    });
  }

  async put(input: PutMediaInput): Promise<PutMediaResult> {
    const format = FORMAT_BY_MIME[input.mime];
    if (format === undefined) throw new CloudinaryError('upload', `unsupported type ${input.mime}`, undefined, false);

    const expectedType = deliveryType(input.visibility);
    const publicId = randomUUID();
    const result = await this.withRetry('upload', () => this.uploadOnce(input, publicId, expectedType));

    // A private file that landed as public would be the worst failure this adapter can have.
    if (
      typeof result.public_id !== 'string' ||
      result.public_id === '' ||
      result.resource_type !== 'image' ||
      result.type !== expectedType
    ) {
      if (typeof result.public_id === 'string' && result.public_id !== '') {
        await this.destroy(result.public_id, result.type as DeliveryKind).catch(() => undefined);
      }
      throw new CloudinaryError(
        'upload',
        `stored as "${result.resource_type}/${result.type}" instead of "image/${expectedType}"; removed`,
        undefined,
        false,
      );
    }

    return {
      storageKey: result.public_id,
      bytes: result.bytes,
      width: result.width,
      height: result.height,
    };
  }

  async delete(ref: MediaObjectRef): Promise<void> {
    await this.destroy(ref.storageKey, deliveryType(ref.visibility));
  }

  urlFor(ref: MediaObjectRef, options: MediaUrlOptions = {}): string {
    if (ref.visibility === 'private') return this.privateDownloadUrl(ref, options);
    const variant = options.variant ?? 'original';
    return cloudinary.url(ref.storageKey, {
      secure: true,
      resource_type: 'image',
      type: 'upload',
      ...(variant === 'original' ? {} : VARIANTS[variant]),
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private privateDownloadUrl(ref: MediaObjectRef, options: MediaUrlOptions): string {
    const format = ref.mime === undefined ? undefined : FORMAT_BY_MIME[ref.mime];
    if (format === undefined) {
      throw new CloudinaryError('private url', 'the file type is needed to build a private link', undefined, false);
    }
    const ttl = Math.min(
      Math.max(Math.trunc(options.expiresInSeconds ?? DEFAULT_PRIVATE_URL_TTL_SECONDS), 1),
      MAX_PRIVATE_URL_TTL_SECONDS,
    );
    return cloudinary.utils.private_download_url(ref.storageKey, format, {
      resource_type: 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + ttl,
    });
  }

  private uploadOnce(
    input: PutMediaInput,
    publicId: string,
    type: 'upload' | 'authenticated',
  ): Promise<UploadApiResponse> {
    return new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${this.config.folder}/${input.folder}`,
          public_id: publicId,
          resource_type: 'image',
          type,
          overwrite: false,
          unique_filename: false,
          use_filename: false,
          // Provider-side allow-list: even if our own check were bypassed, Cloudinary refuses other types.
          allowed_formats: ALLOWED_FORMATS,
          timeout: this.config.timeoutMs,
        },
        (error, result) => {
          if (error || !result) {
            // Rejecting with the SDK's plain object would drop its HTTP code and fail lint; normalise here.
            reject(toCloudinaryError('upload', error ?? new Error('Cloudinary returned no upload result')));
          } else {
            resolve(result);
          }
        },
      );
      stream.end(input.data);
    });
  }

  private async destroy(publicId: string, type: DeliveryKind): Promise<void> {
    // Held in a variable: the SDK honours `timeout` here but its typings omit it.
    const options = { resource_type: 'image' as const, type, invalidate: true, timeout: this.config.timeoutMs };
    await this.withRetry('delete', async () => {
      const response = (await cloudinary.uploader.destroy(publicId, options)) as { result?: unknown };
      // "not found" is fine (already gone); anything else means it was not removed.
      if (response.result !== 'ok' && response.result !== 'not found') {
        throw new CloudinaryError('delete', `unexpected result "${String(response.result)}"`, undefined, false);
      }
    });
  }

  private async withRetry<T>(operation: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await run();
      } catch (raw) {
        const error = toCloudinaryError(operation, raw);
        if (error.isCredentialProblem) {
          console.error('[media] Cloudinary rejected the configured credentials. Check CLOUDINARY_* settings.');
        }
        if (!error.retryable || attempt >= this.config.attempts) throw error;
        const delay = this.config.retryBaseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
        await sleep(delay);
      }
    }
  }
}
