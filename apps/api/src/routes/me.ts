/**
 * GET /api/v1/me
 *
 * The first endpoint a fresh `@rekey.dev/node` client should call to verify
 * its credentials. Returns the Application the presented secret key resolves
 * to: `id`, `tenantId`, `name`, `slug`, `environment`, `publicKey`,
 * `createdAt`, and the `authConfig` / `billingConfig` objects **whole** — not a
 * filtered subset.
 *
 * That is deliberate and safe here, because this route requires an Application
 * secret key (`requireApiKey` rejects the publishable key), so the caller
 * already holds full server-side authority over this Application. But it is not
 * a "public-safe slice": do not proxy this response to a browser assuming it has
 * been redacted. Provider credentials and webhook secrets live in separate
 * encrypted columns and are never part of these two config objects, so no
 * secret material is returned — everything else in them is.
 *
 * ## The response is `ApplicationDto`, and now actually is
 *
 * This shaper is the source of the documented SDK smoke test, and it drifted
 * from the type in two ways that a `: ApplicationDto` annotation would have
 * caught on the day either appeared:
 *
 *   - `environment` is REQUIRED in `ApplicationDtoSchema` and was never sent,
 *     so `app.environment` type-checked as `'live' | 'test'` and was
 *     `undefined` at runtime. An SDK caller branching on it took the wrong
 *     branch in silence.
 *   - `authConfig` / `billingConfig` were declared `unknown` here and passed
 *     through as raw Prisma JSON. The DTO types them as the parsed schemas, so
 *     `AuthConfigSchema`'s defaults and transforms — the ones that fill in
 *     every field an Application stored before that field existed — never ran.
 *     A caller reading `authConfig.passwordMinLength` off an older row got
 *     `undefined` where the type promised a number.
 *
 * The return type is now the DTO itself, so the next divergence is a compile
 * error rather than a runtime surprise.
 */

import type { FastifyInstance } from 'fastify';
import type { Application } from '@prisma/client';
import {
  AppEnvironmentSchema,
  AuthConfigSchema,
  BillingConfigSchema,
  type ApplicationDto,
} from '@rekey.dev/shared-types';
import { requireApiKey, requireScope } from '../middleware/api-key-auth.js';
import { ok, errs, ref } from '../lib/openapi.js';

function toApplicationDto(app: Application): ApplicationDto {
  return {
    id: app.id,
    tenantId: app.tenantId,
    name: app.name,
    slug: app.slug,
    // `AppEnvironmentSchema` enumerates the same three values as the Prisma
    // enum, so this is a parse rather than a cast: if the two ever diverge —
    // a fourth environment added on one side only — this throws here instead
    // of publishing a value the DTO says cannot exist.
    environment: AppEnvironmentSchema.parse(app.environment),
    publicKey: app.publicKey,
    // Parsed, not passed through: the DTO promises the schema's output, which
    // is what applies defaults to rows written before a field existed.
    authConfig: AuthConfigSchema.parse(app.authConfig),
    billingConfig: BillingConfigSchema.parse(app.billingConfig),
    createdAt: app.createdAt.toISOString(),
  };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireApiKey);
  // /me is the credential self-inspection endpoint — read-only.
  app.addHook('onRequest', requireScope('auth:read'));

  app.get(
    '/',
    {
      schema: {
        tags: ['Public · Me'],
        summary: 'Inspect the Application this credential resolves to',
        description:
          'Use this as the SDK smoke test — if it returns 200, your secret key is good.\n\n' +
          'Requires an Application **secret** key with the `auth:read` scope; the publishable ' +
          'key is rejected. Returns an `ApplicationDto`: id, tenantId, name, slug, ' +
          '`environment`, publicKey, createdAt, and the whole `authConfig` / `billingConfig` ' +
          'objects (schema-parsed, so defaults are filled in) rather than a filtered view — ' +
          'safe for the secret-key holder, but do not forward this response to a browser ' +
          'assuming it has been redacted. Provider, OAuth and email credentials live in ' +
          'separate encrypted columns and are never included.',
        security: [{ apiKey: [] }],
        response: {
          200: ok(ref('Application'), 'The Application this secret key resolves to.'),
          ...errs({
            401:
              'API_KEY_MISSING — no `Authorization: Bearer` header; or API_KEY_INVALID — the ' +
              'secret key is unknown, revoked, or expired.',
            403:
              "IP_NOT_ALLOWED — the caller IP is outside the Application's `ipAllowlist`; or " +
              'API_KEY_SCOPE_INSUFFICIENT — the key lacks the `auth:read` scope.',
            429: 'RATE_LIMITED — too many requests for this window. Honour the `Retry-After` header.',
          }),
        },
      },
    },
    async (req) => {
      // requireApiKey guarantees both fields are set; the `!` is safe.
      return {
        success: true,
        data: toApplicationDto(req.application!),
      };
    },
  );
}
