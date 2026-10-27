import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import type { MediaStoragePort, StoredMediaProvider } from '@/server/ports/media';
import { MediaConfigError } from './errors';
import { MediaService, type MediaPortResolver } from './service';
import type { MediaAssetRow } from './repository';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const put = vi.fn(() => Promise.resolve({ storageKey: 's3/new.png', bytes: PNG.length }));

function port(provider: StoredMediaProvider): MediaStoragePort {
  return {
    provider,
    put,
    delete: () => Promise.resolve(),
    urlFor: (ref: { storageKey: string }) => `https://${provider}.example/${ref.storageKey}`,
  };
}

function row(provider: StoredMediaProvider): MediaAssetRow {
  return {
    id: 'media_old',
    provider,
    visibility: 'public',
    storageKey: 'old.png',
    mime: 'image/png',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  } as unknown as MediaAssetRow;
}

function build(existing: MediaAssetRow | null, active: MediaStoragePort, usable: StoredMediaProvider[]) {
  const ports: MediaPortResolver = {
    active: () => active,
    forProvider: (provider) => {
      if (provider === active.provider) return active;
      if (usable.includes(provider)) return port(provider);
      throw new MediaConfigError(`${provider} is not set up`);
    },
  };
  const service = new MediaService({} as DrizzleDb, ports);
  const insert = vi.fn((values: Record<string, unknown>) => Promise.resolve({ ...row(active.provider), ...values }));
  Object.assign(service.repo, { findByHash: () => Promise.resolve(existing), insert });
  return { service, insert };
}

const actor = { id: 'u1', email: 'a@b.c' };
const upload = (service: MediaService) =>
  service.uploadImage({ data: PNG, originalName: 'fish.png', actor });

describe('uploading the same picture twice', () => {
  beforeEach(() => {
    put.mockClear();
  });

  it('reuses the copy the active provider already holds', async () => {
    const s3 = port('s3');
    const { service, insert } = build(row('s3'), s3, []);
    const out = await upload(service);
    expect(out.deduplicated).toBe(true);
    expect(insert).not.toHaveBeenCalled();
  });

  it('stores a new copy when the earlier one lives with a provider that is no longer set up', async () => {
    const s3 = port('s3');
    const { service, insert } = build(row('cloudinary'), s3, []);
    const out = await upload(service);
    expect(out.deduplicated).toBe(false);
    expect(insert).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
  });

  it('still refuses with a configuration error when no provider is usable', async () => {
    const ports: MediaPortResolver = {
      active: () => {
        throw new MediaConfigError('MEDIA_DRIVER must be set');
      },
      forProvider: () => {
        throw new MediaConfigError('nothing');
      },
    };
    const service = new MediaService({} as DrizzleDb, ports);
    await expect(upload(service)).rejects.toBeInstanceOf(MediaConfigError);
  });
});
