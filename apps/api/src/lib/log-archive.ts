/**
 * S3-compatible archive for pruned log rows.
 *
 * Any store that speaks the S3 API: Cloudflare R2
 * (`https://<account>.r2.cloudflarestorage.com`, region `auto`) or AWS S3
 * (`https://s3.<region>.amazonaws.com`). Requests are SigV4-signed with
 * `aws4fetch` rather than the AWS SDK: one PUT is the whole surface, and the
 * SDK is a large dependency to carry for it.
 *
 * Every upload carries `Content-MD5`. That is what lets this write into a
 * bucket with Object Lock enabled, which is what makes an audit archive
 * trustworthy, and also what makes it impossible to erase from. See
 * `docs/data-erasure.md` before turning Object Lock on.
 */

import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { LogArchiver } from './log-retention.js';

export interface LogArchiveConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Normalised: empty, or ending in `/`. */
  prefix: string;
}

export interface LogArchiveEnv {
  LOG_ARCHIVE_S3_ENDPOINT?: string | undefined;
  LOG_ARCHIVE_S3_BUCKET?: string | undefined;
  LOG_ARCHIVE_S3_REGION?: string | undefined;
  LOG_ARCHIVE_S3_ACCESS_KEY_ID?: string | undefined;
  LOG_ARCHIVE_S3_SECRET_ACCESS_KEY?: string | undefined;
  LOG_ARCHIVE_S3_PREFIX?: string | undefined;
}

const REQUIRED = [
  'LOG_ARCHIVE_S3_ENDPOINT',
  'LOG_ARCHIVE_S3_BUCKET',
  'LOG_ARCHIVE_S3_ACCESS_KEY_ID',
  'LOG_ARCHIVE_S3_SECRET_ACCESS_KEY',
] as const;

/**
 * Keys are built from this charset only, so a key never needs URL encoding.
 * That matters more than it looks: SigV4 signs the path, and a key encoded
 * once by us and again by the signer is a signature S3 rejects.
 */
const SAFE_PREFIX = /^[A-Za-z0-9_\-./]*$/;

/**
 * Null when archiving is off; throws when it is half on.
 *
 * All-or-nothing on purpose. Setting a bucket but forgetting a key must not
 * quietly mean "prune without archiving", that deletes rows the operator
 * believes are being kept. Refusing to boot is the only failure an operator
 * cannot miss.
 */
export function resolveLogArchiveConfig(source: LogArchiveEnv): LogArchiveConfig | null {
  const present = REQUIRED.filter((key) => Boolean(source[key]));
  if (present.length === 0) return null;

  const missing = REQUIRED.filter((key) => !source[key]);
  if (missing.length > 0) {
    throw new Error(
      `Log archiving is partly configured: ${present.join(', ')} ${present.length === 1 ? 'is' : 'are'} set ` +
        `but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not. Set all four to archive rows ` +
        `to S3/R2 before they are pruned, or none of them to prune without archiving.`,
    );
  }

  const rawPrefix = source.LOG_ARCHIVE_S3_PREFIX ?? '';
  if (!SAFE_PREFIX.test(rawPrefix)) {
    throw new Error(
      'LOG_ARCHIVE_S3_PREFIX may only contain letters, digits, "_", "-", "." and "/".',
    );
  }
  const trimmed = rawPrefix.replace(/^\/+|\/+$/g, '');

  return {
    endpoint: source.LOG_ARCHIVE_S3_ENDPOINT!.replace(/\/+$/, ''),
    bucket: source.LOG_ARCHIVE_S3_BUCKET!,
    region: source.LOG_ARCHIVE_S3_REGION || 'auto',
    accessKeyId: source.LOG_ARCHIVE_S3_ACCESS_KEY_ID!,
    secretAccessKey: source.LOG_ARCHIVE_S3_SECRET_ACCESS_KEY!,
    prefix: trimmed ? `${trimmed}/` : '',
  };
}

/**
 * A path-style PUT per object. `fetchImpl` is injectable so the request can be
 * asserted in a test without a live bucket.
 */
export function createS3LogArchiver(
  config: LogArchiveConfig,
  fetchImpl: typeof fetch = fetch,
): LogArchiver {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: config.region,
  });

  return {
    async put(key, body) {
      const objectKey = `${config.prefix}${key}`;
      const signed = await client.sign(`${config.endpoint}/${config.bucket}/${objectKey}`, {
        method: 'PUT',
        body: new Uint8Array(body),
        headers: {
          'content-type': 'application/x-ndjson',
          'content-encoding': 'gzip',
          'content-md5': createHash('md5').update(body).digest('base64'),
        },
      });
      const res = await fetchImpl(signed);
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(
          `Log archive upload to ${config.bucket}/${objectKey} failed: HTTP ${res.status}` +
            (detail ? ` — ${detail}` : ''),
        );
      }
    },
  };
}
