import { createHash, createHmac } from 'node:crypto';
import { compareValues } from '@/lib/values';

/**
 * AWS Signature Version 4 for a presigned GET, kept here because the media port builds URLs
 * synchronously and the SDK's presigner is asynchronous. The test cross-checks every URL against the SDK's own.
 */
export interface PresignInput {
  /** The service endpoint as a URL, e.g. https://s3.eu-west-1.amazonaws.com or http://127.0.0.1:9000. */
  endpoint: URL;
  bucket: string;
  region: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style puts the bucket in the path; virtual-hosted puts it in the host name. */
  pathStyle: boolean;
  expiresInSeconds: number;
  now: Date;
}

/** RFC 3986 encoding, which also escapes the characters encodeURIComponent leaves alone. */
const encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/** The object's path: each segment encoded once (S3 does not double-encode), the slashes kept. */
export function objectPath(bucket: string, key: string, pathStyle: boolean): string {
  const encodedKey = key.split('/').map(encode).join('/');
  return pathStyle ? `/${encode(bucket)}/${encodedKey}` : `/${encodedKey}`;
}

/** host[:port] as sent in the Host header: the port only when it is not the scheme's default. */
function hostHeader(url: URL, prefix = ''): string {
  return `${prefix}${url.host}`;
}

export function presignGetUrl(input: PresignInput): string {
  const stamp = input.now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const date = stamp.slice(0, 8);
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const host = hostHeader(input.endpoint, input.pathStyle ? '' : `${input.bucket}.`);
  const path = objectPath(input.bucket, input.key, input.pathStyle);

  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(Math.trunc(input.expiresInSeconds))],
    ['X-Amz-SignedHeaders', 'host'],
    ['x-id', 'GetObject'],
  ];
  const canonicalQuery = query
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => compareValues(a, b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    path,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), 's3'),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');

  const origin = `${input.endpoint.protocol}//${host}`;
  return `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
