/**
 * API key service.
 *
 * Mints and lists Application-scoped secret keys. The prefix follows the
 * Application's `environment`: PRODUCTION apps mint `rp_live_…`, STAGING and
 * DEVELOPMENT apps mint `rp_test_…`. That prefix is a label for humans, not a
 * switch — every key has exactly the reach its Application has.
 *
 * The raw key is returned **once at creation** and never again — only the
 * SHA-256 hash is stored.
 *
 * Verification (looking up an Application by presented key) lives in
 * `verify.ts`, called by the public-API auth middleware.
 */

import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { generateSecretKey, hashKey } from '../../lib/keys.js';
import type { ApiKey, Application } from '@prisma/client';

/**
 * Public-safe shape of an API key — `keyHash` stripped. The hash isn't
 * cryptographically secret (it's a deterministic derivation of the raw
 * key), but exposing it serves no caller and breaks the principle that
 * the hash never leaves the DB.
 */
export type PublicApiKey = Omit<ApiKey, 'keyHash'>;

function redact(key: ApiKey): PublicApiKey {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { keyHash, ...rest } = key;
  return rest;
}

export interface CreateApiKeyInput {
  applicationId: string;
  name: string;
  scopes: string[];
  expiresAt?: Date;
}

export interface CreateApiKeyResult {
  apiKey: PublicApiKey;
  /** Raw key. Show to the user **once**, then forget. */
  rawKey: string;
}

const DEFAULT_SCOPES = ['*'];
/**
 * Hard ceiling on ACTIVE keys per Application, enforced at mint time.
 *
 * Exported because it is what makes this list bounded by construction — the
 * three routes that serve it lean on that fact (two return a bare array,
 * allow-listed in `test/openapi-contract.test.ts`; the operator-PAT one
 * reports this value as its page `limit`).
 */
export const MAX_KEYS_PER_APP = 25;

export const apiKeysService = {
  async listForApplication(applicationId: string): Promise<PublicApiKey[]> {
    const keys = await prisma.apiKey.findMany({
      where: { applicationId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return keys.map(redact);
  },

  async create(input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    // A non-future expiry would mint a key that `verify()` immediately rejects
    // as expired — a dead-on-arrival credential the operator was told was
    // "created". Fail fast with a clear error instead.
    if (input.expiresAt !== undefined && input.expiresAt.getTime() <= Date.now()) {
      throw new RekeyError({
        statusCode: 400,
        code: 'API_KEY_EXPIRY_IN_PAST',
        message: `expiresAt (${input.expiresAt.toISOString()}) is not in the future — the key would be dead on arrival.`,
        fix: 'Pass a future expiresAt, or omit it for a non-expiring key.',
      });
    }

    const activeCount = await prisma.apiKey.count({
      where: { applicationId: input.applicationId, revokedAt: null },
    });
    if (activeCount >= MAX_KEYS_PER_APP) {
      throw new RekeyError({
        statusCode: 400,
        code: 'API_KEY_LIMIT_REACHED',
        message: `Application already has ${MAX_KEYS_PER_APP} active API keys.`,
        fix: 'Revoke an unused key before creating a new one.',
      });
    }

    // The prefix is derived from the Application, never from the caller: a
    // PRODUCTION app mints rp_live_*, everything else rp_test_*. Letting the
    // caller pick would put the two out of sync, and the prefix is the one
    // thing a human reads before pasting a key somewhere.
    const application = await prisma.application.findUnique({
      where: { id: input.applicationId },
      select: { environment: true },
    });
    if (!application) {
      throw new RekeyError({
        statusCode: 404,
        code: 'APPLICATION_NOT_FOUND',
        message: `Application "${input.applicationId}" not found.`,
        fix: 'List applications with GET /api/v1/admin/applications.',
      });
    }
    const { raw, hash, prefix } = generateSecretKey(
      application.environment === 'PRODUCTION' ? 'live' : 'test',
    );

    const apiKey = await prisma.apiKey.create({
      data: {
        applicationId: input.applicationId,
        name: input.name,
        keyPrefix: prefix,
        keyHash: hash,
        scopes: input.scopes.length > 0 ? input.scopes : DEFAULT_SCOPES,
        ...(input.expiresAt !== undefined && { expiresAt: input.expiresAt }),
      },
    });

    return { apiKey: redact(apiKey), rawKey: raw };
  },

  async revoke(applicationId: string, id: string): Promise<PublicApiKey> {
    const key = await prisma.apiKey.findUnique({ where: { id } });
    if (!key || key.applicationId !== applicationId) {
      throw new RekeyError({
        statusCode: 404,
        code: 'API_KEY_NOT_FOUND',
        message: `API key "${id}" not found in application "${applicationId}".`,
        fix: 'List keys with GET /api/v1/admin/applications/:id/api-keys.',
      });
    }
    if (key.revokedAt !== null) {
      // Idempotent — re-revoking is fine, just return the existing record.
      return redact(key);
    }
    const revoked = await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return redact(revoked);
  },

  /**
   * Resolve a presented raw key to its Application. Returns null if the key
   * is unknown, revoked, or expired. Constant-time-friendly because we look
   * up by hash (the hash *is* the index key).
   *
   * The Application row rides along via `include`: the auth middleware needs
   * it on every request, and fetching it here turns the hot path's two
   * sequential round trips into one query.
   */
  async verify(
    rawKey: string,
  ): Promise<{ apiKey: ApiKey; applicationId: string; application: Application } | null> {
    const withApp = await prisma.apiKey.findUnique({
      where: { keyHash: hashKey(rawKey) },
      include: { application: true },
    });
    if (!withApp) return null;
    if (withApp.revokedAt !== null) return null;
    if (withApp.expiresAt !== null && withApp.expiresAt <= new Date()) return null;
    const { application, ...apiKey } = withApp;
    return { apiKey, applicationId: apiKey.applicationId, application };
  },
};
