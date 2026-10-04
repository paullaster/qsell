/**
 * Contract test for the Cloudinary media adapter, run against a local FAKE Cloudinary.
 *
 *   npx tsx scripts/verify-cloudinary-adapter.ts
 *
 * No credentials or network needed. The fake verifies request signatures the way the
 * real API does and can be told to fail in specific ways (5xx, rate limit, hang,
 * dropped connection, lost response), so the adapter's retry, timeout and
 * safety checks run over real HTTP.
 *
 * What this does NOT prove is that real Cloudinary behaves like the fake. For that,
 * run `scripts/check-media-provider.ts` once with real credentials.
 */
/* eslint-disable no-console -- a CLI check: printing the results is its whole job */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const CLOUD = 'testcloud';
const KEY = 'test-key';
const SECRET = 'test-secret';

// ── fake Cloudinary ─────────────────────────────────────────────────────────

interface StoredAsset {
  publicId: string;
  type: string;
  bytes: number;
  width: number;
  height: number;
}

const assets = new Map<string, StoredAsset>();
const requestLog: { action: string; publicId: string }[] = [];

/** One-shot misbehaviours, consumed in order by the next matching requests. */
const faults: {
  statuses: number[];
  hangMs: number[];
  dropConnection: number;
  dropResponseAfterStore: number;
  forceType: string | null;
  destroyResult: string | null;
} = { statuses: [], hangMs: [], dropConnection: 0, dropResponseAfterStore: 0, forceType: null, destroyResult: null };

function resetFaults(): void {
  faults.statuses = [];
  faults.hangMs = [];
  faults.dropConnection = 0;
  faults.dropResponseAfterStore = 0;
  faults.forceType = null;
  faults.destroyResult = null;
  requestLog.length = 0;
}

function parseMultipart(body: Buffer, contentType: string): Map<string, Buffer> {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = Buffer.from(`--${match?.[1] ?? match?.[2] ?? ''}`);
  const fields = new Map<string, Buffer>();
  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    const start = cursor + boundary.length;
    const next = body.indexOf(boundary, start);
    if (next === -1) break;
    const part = body.subarray(start, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const name = /name="([^"]+)"/.exec(part.subarray(0, headerEnd).toString('latin1'))?.[1];
      if (name !== undefined) fields.set(name, part.subarray(headerEnd + 4, part.length - 2));
    }
    cursor = next;
  }
  return fields;
}

const UNSIGNED = new Set(['file', 'cloud_name', 'resource_type', 'api_key', 'signature']);

function signatureOk(fields: Map<string, Buffer>): boolean {
  const toSign = [...fields.entries()]
    .filter(([name]) => !UNSIGNED.has(name))
    .map(([name, value]) => `${name}=${value.toString('utf8')}`)
    .sort()
    .join('&');
  const algorithm = fields.get('signature_algorithm')?.toString('utf8') ?? 'sha1';
  const expected = createHash(algorithm === 'sha256' ? 'sha256' : 'sha1').update(toSign + SECRET).digest('hex');
  return fields.get('signature')?.toString('utf8') === expected && fields.get('api_key')?.toString('utf8') === KEY;
}

function pngSize(file: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (file.length < 24 || !file.subarray(0, 4).equals(signature)) return null;
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://fake');
  const route = /^\/v1_1\/([^/]+)\/image\/(upload|destroy|download)$/.exec(url.pathname);
  if (route?.[1] !== CLOUD) { json(res, 404, { error: { message: 'Not found' } }); return; }
  const action = route[2];

  // GET download: a signed, expiring link (what private files are served through).
  if (action === 'download') {
    const query = new Map(url.searchParams.entries());
    const fields = new Map([...query.entries()].map(([k, v]) => [k, Buffer.from(v)]));
    if (!signatureOk(new Map([...fields, ['api_key', Buffer.from(KEY)]]))) {
      // The download URL signs without api_key in the string; re-check on its own terms.
      const toSign = [...query.entries()].filter(([k]) => k !== 'signature' && k !== 'api_key').map(([k, v]) => `${k}=${v}`).sort().join('&');
      const expected = createHash('sha1').update(toSign + SECRET).digest('hex');
      if (query.get('signature') !== expected) { json(res, 401, { error: { message: 'Invalid Signature' } }); return; }
    }
    if (Number(query.get('expires_at')) < Math.floor(Date.now() / 1000)) {
      json(res, 401, { error: { message: 'Request expired' } }); return;
    }
    const asset = assets.get(`${query.get('type') ?? ''}/${query.get('public_id') ?? ''}`);
    if (asset) json(res, 200, { ok: true });
    else json(res, 404, { error: { message: 'Resource not found' } });
    return;
  }

  const body = await readBody(req);
  const fields = parseMultipart(body, req.headers['content-type'] ?? '');
  const field = (name: string): string => fields.get(name)?.toString('utf8') ?? '';
  const folder = field('folder');
  const publicId = field('public_id');
  const fullId = folder !== '' ? `${folder}/${publicId}` : publicId;
  requestLog.push({ action, publicId: fullId });

  const hang = faults.hangMs.shift();
  if (hang !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, hang));
    return;
  }
  if (faults.dropConnection > 0) {
    faults.dropConnection -= 1;
    req.socket.destroy();
    return;
  }
  const status = faults.statuses.shift();
  if (status !== undefined) {
    json(res, status, { error: { message: `injected ${status}` } }); return;
  }

  if (!signatureOk(fields)) {
    json(res, 401, { error: { message: 'Invalid Signature (fake)' } }); return;
  }

  if (action === 'destroy') {
    const requested = field('type');
    const type = requested === '' ? 'upload' : requested;
    const key = `${type}/${publicId}`;
    const existed = assets.delete(key);
    json(res, 200, { result: faults.destroyResult ?? (existed ? 'ok' : 'not found') }); return;
  }

  // upload
  const file = fields.get('file') ?? Buffer.alloc(0);
  const size = pngSize(file);
  const allowed = field('allowed_formats').split(',').filter(Boolean);
  if (size === null || (allowed.length > 0 && !allowed.includes('png'))) {
    json(res, 400, { error: { message: 'Invalid image file' } }); return;
  }
  // `forceType` models Cloudinary storing the asset under a different delivery type than requested.
  const requested = field('type');
  const type = faults.forceType ?? (requested === '' ? 'upload' : requested);
  const key = `${type}/${fullId}`;
  const existing = assets.get(key);
  const stored: StoredAsset = existing ?? { publicId: fullId, type, bytes: file.length, ...size };
  const created = existing === undefined;
  if (created) assets.set(key, stored);

  if (faults.dropResponseAfterStore > 0) {
    faults.dropResponseAfterStore -= 1;
    req.socket.destroy();
    return;
  }
  json(res, 200, {
    public_id: stored.publicId,
    version: 1,
    width: stored.width,
    height: stored.height,
    format: 'png',
    resource_type: 'image',
    type: stored.type,
    bytes: stored.bytes,
    existing: !created,
  });
}

// ── test harness ────────────────────────────────────────────────────────────

let failures = 0;
function ok(condition: boolean, label: string): void {
  console.log(`${condition ? '✓' : '✗'} ${label}`);
  if (!condition) failures += 1;
}

function png(width: number, height: number): Buffer {
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32(13),
    Buffer.from('IHDR'),
    u32(width),
    u32(height),
    Buffer.alloc(5),
    Buffer.from(randomUUID()),
  ]);
}

async function outcome<T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> {
  return await promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error }),
  );
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handle(req, res).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  // The SDK reads `upload_prefix` once, when it is first imported, so configure it first.
  process.env.CLOUDINARY_URL = `cloudinary://${KEY}:${SECRET}@${CLOUD}?upload_prefix=http://127.0.0.1:${port}`;
  const { CloudinaryMediaAdapter, CloudinaryError, cloudinaryConfigFromEnv } = await import(
    '@/server/adapters/media/cloudinary.adapter'
  );

  const config = (overrides: Record<string, unknown> = {}) => ({
    cloudName: CLOUD,
    apiKey: KEY,
    apiSecret: SECRET,
    folder: 'qsell',
    timeoutMs: 5_000,
    attempts: 3,
    retryBaseDelayMs: 1,
    ...overrides,
  });
  const adapter = (overrides: Record<string, unknown> = {}) => new CloudinaryMediaAdapter(config(overrides));
  const seen = (action: string) => requestLog.filter((r) => r.action === action);

  // ── configuration ──
  const env = (extra: Record<string, string>) => ({ NODE_ENV: 'test', ...extra }) as NodeJS.ProcessEnv;
  const thrown = (fn: () => unknown): string => {
    try {
      fn();
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  };
  ok(
    cloudinaryConfigFromEnv(env({ CLOUDINARY_URL: 'cloudinary://k:s@my-cloud' })).cloudName === 'my-cloud',
    'config: reads CLOUDINARY_URL',
  );
  ok(
    cloudinaryConfigFromEnv(env({ CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's' })).apiKey === 'k',
    'config: reads the three discrete variables',
  );
  const noSecret = thrown(() => cloudinaryConfigFromEnv(env({ CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'AKEY123' })));
  ok(noSecret.includes('needs CLOUDINARY_URL') && !noSecret.includes('AKEY123'), 'config: missing secret is reported without echoing other values');
  ok(thrown(() => cloudinaryConfigFromEnv(env({ CLOUDINARY_URL: 'nonsense' }))).includes('not a valid URL'), 'config: malformed CLOUDINARY_URL is explained');
  ok(thrown(() => cloudinaryConfigFromEnv(env({ CLOUDINARY_URL: 'cloudinary://k:s@bad cloud!' }))) !== '', 'config: invalid cloud name rejected');
  for (const folder of ['../etc', 'a//b', 'a b', '-lead']) {
    ok(thrown(() => cloudinaryConfigFromEnv(env({ CLOUDINARY_URL: 'cloudinary://k:s@c', CLOUDINARY_FOLDER: folder }))).includes('CLOUDINARY_FOLDER'), `config: folder ${JSON.stringify(folder)} rejected`);
  }
  const bounded = cloudinaryConfigFromEnv(env({ CLOUDINARY_URL: 'cloudinary://k:s@c', CLOUDINARY_TIMEOUT_MS: '9999999', CLOUDINARY_ATTEMPTS: '50' }));
  ok(bounded.timeoutMs === 30_000 && bounded.attempts === 3, 'config: out-of-range timeout/attempts fall back to safe defaults');

  // ── upload ──
  resetFaults();
  const up = await adapter().put({ data: png(640, 480), mime: 'image/png', folder: 'product', visibility: 'public' });
  ok(up.storageKey.startsWith('qsell/product/') && up.width === 640 && up.height === 480 && up.bytes > 0, `upload: stored under the configured folder with provider-reported size (${up.storageKey})`);
  ok(assets.get(`upload/${up.storageKey}`) !== undefined, 'upload: public asset has delivery type "upload"');

  const priv = await adapter().put({ data: png(10, 10), mime: 'image/png', folder: 'document', visibility: 'private' });
  ok(assets.get(`authenticated/${priv.storageKey}`) !== undefined && assets.get(`upload/${priv.storageKey}`) === undefined, 'upload: private asset has delivery type "authenticated" and is not stored as public');

  const unsupported = await outcome(adapter().put({ data: png(1, 1), mime: 'image/svg+xml', folder: 'product', visibility: 'public' }));
  ok(unsupported.error instanceof CloudinaryError && seen('upload').length === 2, 'upload: unsupported type refused locally, nothing sent');

  // ── retries ──
  resetFaults();
  faults.statuses = [503, 500];
  const retried = await adapter().put({ data: png(5, 5), mime: 'image/png', folder: 'product', visibility: 'public' });
  const ids = new Set(seen('upload').map((r) => r.publicId));
  ok(seen('upload').length === 3 && ids.size === 1 && assets.has(`upload/${retried.storageKey}`), 'retry: two 5xx then success, same public_id on every attempt, one asset');

  resetFaults();
  faults.statuses = [500, 500, 500, 500];
  const exhausted = await outcome(adapter().put({ data: png(5, 5), mime: 'image/png', folder: 'product', visibility: 'public' }));
  ok(exhausted.error instanceof CloudinaryError && exhausted.error.retryable && exhausted.error.httpCode === 500 && seen('upload').length === 3, 'retry: gives up after the configured attempts with a typed, retryable error');

  resetFaults();
  faults.statuses = [429];
  await adapter().put({ data: png(5, 5), mime: 'image/png', folder: 'product', visibility: 'public' });
  ok(seen('upload').length === 2, 'retry: rate limit (429) is retried');

  resetFaults();
  const bad = await outcome(adapter().put({ data: Buffer.concat([png(5, 5).subarray(0, 8), Buffer.from('broken')]), mime: 'image/png', folder: 'product', visibility: 'public' }));
  ok(bad.error instanceof CloudinaryError && !bad.error.retryable && bad.error.httpCode === 400 && seen('upload').length === 1, 'no retry: a 400 (bad image) fails once, not retryable');

  resetFaults();
  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => void logged.push(args.join(' '));
  const wrong = await outcome(adapter({ apiSecret: 'wrong-secret' }).put({ data: png(5, 5), mime: 'image/png', folder: 'product', visibility: 'public' }));
  console.error = realError;
  ok(wrong.error instanceof CloudinaryError && wrong.error.isCredentialProblem && !wrong.error.retryable && seen('upload').length === 1, 'no retry: bad credentials (401) fail once and are flagged as a credential problem');
  ok(logged.some((line) => line.includes('rejected the configured credentials')) && !logged.some((line) => line.includes('wrong-secret') || line.includes(SECRET)), 'bad credentials log a clear hint and never print a secret');

  resetFaults();
  faults.dropConnection = 1;
  await adapter().put({ data: png(5, 5), mime: 'image/png', folder: 'product', visibility: 'public' });
  ok(seen('upload').length === 2, 'retry: a dropped connection is retried');

  resetFaults();
  faults.dropResponseAfterStore = 1;
  const before = assets.size;
  const lost = await adapter().put({ data: png(6, 6), mime: 'image/png', folder: 'product', visibility: 'public' });
  ok(assets.size === before + 1 && seen('upload').length === 2 && new Set(seen('upload').map((r) => r.publicId)).size === 1, 'idempotent retry: response lost after the file was stored → retry reuses it, no duplicate asset');
  ok(assets.has(`upload/${lost.storageKey}`), 'idempotent retry: returned key is the stored asset');

  // ── timeout ──
  resetFaults();
  faults.hangMs = [3_000, 3_000];
  const started = Date.now();
  const timedOut = await outcome(adapter({ timeoutMs: 300, attempts: 2 }).put({ data: png(5, 5), mime: 'image/png', folder: 'product', visibility: 'public' }));
  const elapsed = Date.now() - started;
  ok(timedOut.error instanceof CloudinaryError && timedOut.error.retryable && seen('upload').length === 2 && elapsed < 2_500, `timeout: a hung request is cut off and retried, then fails fast (${elapsed} ms for 2 attempts)`);

  // ── safety check: private must not land as public ──
  resetFaults();
  faults.forceType = 'upload';
  const countBefore = assets.size;
  const leaked = await outcome(adapter().put({ data: png(7, 7), mime: 'image/png', folder: 'document', visibility: 'private' }));
  ok(leaked.error instanceof CloudinaryError && !leaked.error.retryable && leaked.error.message.includes('instead of'), 'safety: private upload reported as public is rejected');
  ok(assets.size === countBefore, 'safety: ...and the mis-stored asset is removed');

  // ── delete ──
  resetFaults();
  await adapter().delete({ storageKey: up.storageKey, visibility: 'public' });
  ok(!assets.has(`upload/${up.storageKey}`), 'delete: removes the asset');
  await adapter().delete({ storageKey: up.storageKey, visibility: 'public' });
  ok(true, 'delete: deleting something already gone is not an error ("not found")');
  await adapter().delete({ storageKey: priv.storageKey, visibility: 'private' });
  ok(!assets.has(`authenticated/${priv.storageKey}`), 'delete: private asset removed using the authenticated type');
  resetFaults();
  faults.statuses = [502];
  const keep = await adapter().put({ data: png(8, 8), mime: 'image/png', folder: 'product', visibility: 'public' });
  resetFaults();
  faults.statuses = [502];
  await adapter().delete({ storageKey: keep.storageKey, visibility: 'public' });
  ok(seen('destroy').length === 2 && !assets.has(`upload/${keep.storageKey}`), 'delete: a transient 5xx is retried');
  resetFaults();
  faults.destroyResult = 'error';
  const odd = await outcome(adapter().delete({ storageKey: 'qsell/product/none', visibility: 'public' }));
  ok(odd.error instanceof CloudinaryError && odd.error.message.includes('unexpected result'), 'delete: an unexpected result is surfaced, not swallowed');

  // ── URLs ──
  const a = adapter();
  const original = a.urlFor({ storageKey: 'qsell/product/abc', visibility: 'public' });
  ok(original.endsWith("/image/upload/v1/qsell/product/abc") && !original.includes('?'), 'url: public original is a clean, unsigned CDN URL');
  const thumb = a.urlFor({ storageKey: 'qsell/product/abc', visibility: 'public' }, { variant: 'thumb' });
  ok(thumb.includes('c_fill,f_auto,g_auto,h_160,q_auto,w_160'), 'url: variants become delivery transformations');

  const now = Math.floor(Date.now() / 1000);
  const link = new URL(a.urlFor({ storageKey: 'qsell/document/def', visibility: 'private', mime: 'image/png' }));
  const expiresAt = Number(link.searchParams.get('expires_at'));
  ok(link.searchParams.get('type') === 'authenticated' && link.searchParams.get('format') === 'png' && link.searchParams.has('signature'), 'url: private link is a signed authenticated download');
  ok(expiresAt >= now + 295 && expiresAt <= now + 305, `url: private link expires in ~5 minutes by default (${expiresAt - now}s)`);
  const longer = new URL(a.urlFor({ storageKey: 'k', visibility: 'private', mime: 'image/png' }, { expiresInSeconds: 999_999 }));
  ok(Number(longer.searchParams.get('expires_at')) <= now + 3_605, 'url: requested lifetime is capped at one hour');
  ok(a.urlFor({ storageKey: 'k', visibility: 'private', mime: 'image/png' }, { variant: 'thumb' }) !== '' && !a.urlFor({ storageKey: 'k', visibility: 'private', mime: 'image/png' }, { variant: 'thumb' }).includes('w_160'), 'url: private files ignore variants (original only)');
  ok(thrown(() => a.urlFor({ storageKey: 'k', visibility: 'private' })) !== '', 'url: a private link without a known file type is refused, not guessed');

  // the link works while valid, and the fake enforces the signed expiry like the real API
  const stored = await adapter().put({ data: png(9, 9), mime: 'image/png', folder: 'document', visibility: 'private' });
  const live = a.urlFor({ storageKey: stored.storageKey, visibility: 'private', mime: 'image/png' });
  ok((await fetch(live)).status === 200, 'download: a fresh private link works');
  const tampered = new URL(live);
  tampered.searchParams.set('expires_at', String(now + 99_999));
  ok((await fetch(tampered)).status === 401, 'download: changing the expiry invalidates the signature');
  const shortLived = a.urlFor({ storageKey: stored.storageKey, visibility: 'private', mime: 'image/png' }, { expiresInSeconds: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  ok((await fetch(shortLived)).status === 401, 'download: an expired private link is refused');

  server.close();
  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
