/**
 * Live smoke test for the configured media provider. Run it once after setting
 * credentials, and again after changing them:
 *
 *   npx tsx scripts/check-media-provider.ts            # uses MEDIA_DRIVER (default: cloudinary)
 *   npx tsx scripts/check-media-provider.ts cloudinary
 *
 * It uploads two tiny test images (one public, one private), checks they can be
 * read the way the app reads them, checks the private one is NOT reachable without
 * a signed link, then deletes everything it created. It touches no database.
 *
 * Needs real credentials, so it makes real (billable but tiny) API calls.
 * The offline counterpart is `scripts/verify-cloudinary-adapter.ts`.
 */
/* eslint-disable no-console -- a CLI check: printing the results is its whole job */
import 'dotenv/config';
import { deflateSync, crc32 } from 'node:zlib';
import { MediaPortRegistry } from '@/server/adapters/media/registry';
import { cloudinaryConfigFromEnv } from '@/server/adapters/media/cloudinary.adapter';
import type { MediaObjectRef } from '@/server/ports/media';

/** A real, decodable PNG: providers reject files that merely look like images. */
export function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let failures = 0;
function report(passed: boolean, label: string, detail = ''): void {
  console.log(`${passed ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`);
  if (!passed) failures += 1;
}

async function status(url: string): Promise<{ code: number; type: string }> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: 'follow' });
    await response.arrayBuffer();
  } catch (error) {
    // undici reports every network failure as a bare "fetch failed"; the real reason is on `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    throw new Error(`Could not reach ${new URL(url).host}${cause}`, { cause: error });
  }
  return { code: response.status, type: response.headers.get('content-type') ?? '' };
}

async function main(): Promise<void> {
  const provider = (process.argv.at(2) ?? process.env.MEDIA_DRIVER ?? 'cloudinary').toLowerCase();
  if (provider !== 'cloudinary' && provider !== 'local') {
    throw new Error(`Unknown provider "${provider}". Use "cloudinary" or "local".`);
  }
  const port = new MediaPortRegistry().forProvider(provider);
  console.log(`Checking provider: ${provider}\n`);

  const created: MediaObjectRef[] = [];
  try {
    // Public image
    const publicFile = await port.put({ data: solidPng(64, 48, [200, 40, 40]), mime: 'image/png', folder: 'smoke-test', visibility: 'public' });
    const publicRef: MediaObjectRef = { storageKey: publicFile.storageKey, visibility: 'public', mime: 'image/png' };
    created.push(publicRef);
    report(true, 'upload (public)', `${publicFile.storageKey}${publicFile.width !== undefined && publicFile.height !== undefined ? ` ${publicFile.width}x${publicFile.height}` : ''}`);

    const base = provider === 'local' ? `http://localhost:${process.env.PORT ?? 3000}` : '';
    const original = await status(base + port.urlFor(publicRef));
    report(original.code === 200 && original.type.startsWith('image/'), 'public URL serves the image', `HTTP ${original.code} ${original.type}`);
    const thumb = await status(base + port.urlFor(publicRef, { variant: 'thumb' }));
    report(thumb.code === 200 && thumb.type.startsWith('image/'), 'thumbnail variant is generated', `HTTP ${thumb.code} ${thumb.type}`);

    // Private image
    const privateFile = await port.put({ data: solidPng(32, 32, [40, 70, 200]), mime: 'image/png', folder: 'smoke-test', visibility: 'private' });
    const privateRef: MediaObjectRef = { storageKey: privateFile.storageKey, visibility: 'private', mime: 'image/png' };
    created.push(privateRef);
    report(true, 'upload (private)', privateFile.storageKey);

    if (provider === 'cloudinary') {
      const signed = await status(port.urlFor(privateRef));
      report(signed.code === 200 && signed.type.startsWith('image/'), 'private file readable through a signed, expiring link', `HTTP ${signed.code} ${signed.type}`);

      const { cloudName } = cloudinaryConfigFromEnv();
      const guessed = await status(`https://res.cloudinary.com/${cloudName}/image/authenticated/${privateFile.storageKey}.png`);
      report(guessed.code !== 200, 'private file is NOT readable by guessing its URL', `HTTP ${guessed.code}`);
      const asPublic = await status(`https://res.cloudinary.com/${cloudName}/image/upload/${privateFile.storageKey}.png`);
      report(asPublic.code !== 200, 'private file is NOT reachable as a public asset', `HTTP ${asPublic.code}`);
    } else {
      report(true, 'private file checks skipped (local adapter: access is enforced by the app route)');
    }

    // The provider must refuse non-images even though our own validation also does.
    let refused = false;
    try {
      const junk = await port.put({ data: Buffer.from('this is not an image'), mime: 'image/png', folder: 'smoke-test', visibility: 'public' });
      created.push({ storageKey: junk.storageKey, visibility: 'public' });
    } catch {
      refused = true;
    }
    report(refused, 'a non-image is refused at the provider');
  } finally {
    // Always clean up, and say so if cleanup itself fails: leftover files cost money.
    for (const ref of created) {
      try {
        await port.delete(ref);
        report(true, 'cleanup: deleted', ref.storageKey);
      } catch (error) {
        report(false, 'cleanup FAILED, delete this manually', `${ref.storageKey}: ${(error as Error).message}`);
      }
    }
  }

  if (provider === 'cloudinary' && created.length > 0) {
    const first = created[0];
    const base = new MediaPortRegistry().forProvider('cloudinary').urlFor(first);
    const after = await status(base);
    // A CDN may keep serving a cached copy for a while after deletion; informational only.
    console.log(`  (info) public URL after delete: HTTP ${after.code}${after.code === 200 ? ' - still cached at the CDN; it clears on its own' : ''}`);
  }

  console.log(`\n${failures === 0 ? 'Provider looks good.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
