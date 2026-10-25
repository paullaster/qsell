/**
 * Creates the media bucket on a store that runs next to the app (the bundled RustFS) when it does not
 * exist yet. Safe to run on every deploy: an existing bucket is left alone, and nothing is made public.
 *
 *   pnpm media:bucket
 */
/* eslint-disable no-console -- a CLI step: printing the result is its whole job */
import 'dotenv/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { s3ConfigFromEnv } from '@/server/adapters/media/s3.adapter';

/** The store may still be starting when the deploy reaches this step. */
async function untilReachable(
  client: S3Client,
  bucket: string,
  tries = 30,
): Promise<'exists' | 'missing'> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return 'exists';
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404)
        return 'missing';
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 403) {
        throw new Error(
          'The store refused the access key. Check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.',
          { cause: error },
        );
      }
      if (attempt >= tries)
        throw new Error(
          'The store could not be reached. Check S3_ENDPOINT and that the storage service is running.',
          { cause: error },
        );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main(): Promise<void> {
  const config = s3ConfigFromEnv();
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint.origin,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  if ((await untilReachable(client, config.bucket)) === 'exists') {
    console.log(`Bucket "${config.bucket}" already exists.`);
    return;
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    if (!(error instanceof S3ServiceException) || error.name !== 'BucketAlreadyOwnedByYou')
      throw error;
  }
  console.log(`Bucket "${config.bucket}" created.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Could not prepare the media bucket.');
  process.exit(1);
});
