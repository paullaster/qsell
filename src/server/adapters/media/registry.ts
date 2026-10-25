import type { MediaStoragePort, StoredMediaProvider } from '@/server/ports/media';
import { MediaConfigError } from '@/server/domains/media/errors';
import type { MediaPortResolver } from '@/server/domains/media/service';
import { CloudinaryMediaAdapter } from './cloudinary.adapter';
import { LocalMediaAdapter } from './local.adapter';
import { S3MediaAdapter } from './s3.adapter';

/**
 * `MEDIA_DRIVER`: where new uploads go. Existing assets keep resolving to their own provider.
 * Left unset, S3-compatible storage is used when a bucket is configured (`S3_BUCKET`); otherwise local
 * disk in development, and an error in production, where local disk is not durable in containers.
 */
export function configuredMediaDriver(env: NodeJS.ProcessEnv = process.env): StoredMediaProvider {
  const raw = env.MEDIA_DRIVER?.trim().toLowerCase();
  if (raw === 's3' || raw === 'local' || raw === 'cloudinary') return raw;
  if (raw !== undefined && raw !== '')
    throw new Error(`Unknown MEDIA_DRIVER "${raw}". Use "s3", "local" or "cloudinary".`);
  if ((env.S3_BUCKET?.trim() ?? '') !== '') return 's3';
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'MEDIA_DRIVER must be set in production: local disk is not durable in containers.',
    );
  }
  return 'local';
}

/**
 * Builds adapters on first use, so a missing credential for a provider nobody
 * is using never breaks the app, and pasted links work with no provider at all.
 */
export class MediaPortRegistry implements MediaPortResolver {
  private readonly adapters = new Map<StoredMediaProvider, MediaStoragePort>();

  active(): MediaStoragePort {
    let driver: StoredMediaProvider;
    try {
      driver = configuredMediaDriver();
    } catch (error) {
      throw new MediaConfigError(
        error instanceof Error ? error.message : 'Media storage is not configured.',
      );
    }
    return this.forProvider(driver);
  }

  private build(provider: StoredMediaProvider): MediaStoragePort {
    if (provider === 's3') return new S3MediaAdapter();
    if (provider === 'cloudinary') return new CloudinaryMediaAdapter();
    return new LocalMediaAdapter();
  }

  forProvider(provider: StoredMediaProvider): MediaStoragePort {
    let adapter = this.adapters.get(provider);
    if (!adapter) {
      try {
        adapter = this.build(provider);
      } catch (error) {
        throw new MediaConfigError(
          error instanceof Error ? error.message : `Media provider "${provider}" is misconfigured.`,
        );
      }
      this.adapters.set(provider, adapter);
    }
    return adapter;
  }
}
