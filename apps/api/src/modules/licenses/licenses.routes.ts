/**
 * License management routes.
 *
 * Tenant operator surface (under /api/v1/tenant/applications/:id/licenses)
 * lives in tenant-applications.routes.ts to keep all tenant-scoped
 * resources in one place.
 *
 * THIS file ships the public verification endpoint
 * (POST /api/v1/licenses/verify) — that's what the customer's software
 * calls at startup with the raw license key + a machine fingerprint.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { licensesService } from './licenses.service.js';
import { requirePublishableOrSecretKey, requireScope } from '../../middleware/api-key-auth.js';
import { requireBillingEnabled } from '../../middleware/billing-enabled.js';
import { ok, errs, ref } from '../../lib/openapi.js';

const VerifyBody = z.object({
  key: z.string().min(1).max(256),
  machineFingerprint: z.string().min(1).max(256),
  label: z.string().min(1).max(120).optional(),
});

export async function licensesPublicRoutes(app: FastifyInstance): Promise<void> {
  // A desktop/client app verifies its own license at startup with no backend,
  // so this accepts the publishable key (or a secret key). The actual
  // entitlement bearer is the license `key` in the body — the publishable key
  // only identifies which Application's licenses to check against.
  app.addHook('onRequest', requirePublishableOrSecretKey);
  app.addHook('onRequest', requireBillingEnabled);
  // /verify both reads license state and writes activation rows; treat as
  // billing:write since licenses are a billing-tier artefact (publishable
  // requests are pre-authorized by route membership).
  app.addHook('onRequest', requireScope('billing:write'));

  app.post(
    '/verify',
    {
      schema: {
        tags: ['Public · Licenses'],
        summary: 'Verify a license key + record an activation for this machine',
        description:
          'Returns { ok, license?, reason? }. `ok=false` is intentional for invalid licenses — ' +
          'the customer\'s software loops on this and we want a deterministic body, not an HTTP error.',
        security: [{ apiKey: [] }, { publishableKey: [] }],
        body: {
          type: 'object',
          required: ['key', 'machineFingerprint'],
          properties: {
            key: { type: 'string', minLength: 1, maxLength: 256 },
            machineFingerprint: { type: 'string', minLength: 1, maxLength: 256 },
            label: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        response: {
          // Always 200 — `verify()` never throws for an invalid/expired/
          // revoked/seats-exhausted license; `ok: false` + `reason` IS the
          // deterministic failure body the description promises.
          200: ok(ref('LicenseVerifyResult'), 'Verification outcome — check `ok` before `license`.'),
          ...errs({
            400: 'VALIDATION_ERROR — the body failed schema validation.',
            401:
              'API_KEY_MISSING / API_KEY_INVALID — the secret key is missing, malformed, or ' +
              'unknown/revoked/expired; or PUBLISHABLE_KEY_INVALID — the publishable key is ' +
              'unknown or has rotated out.',
            403:
              "IP_NOT_ALLOWED — caller IP outside the secret key's allowlist; or " +
              "ORIGIN_NOT_ALLOWED — the Origin is outside the publishable key's CORS allowlist; " +
              'or BILLING_DISABLED — billing is not enabled for this application; or ' +
              'API_KEY_SCOPE_INSUFFICIENT — the secret key lacks the `billing:write` scope.',
            429: 'RATE_LIMITED — too many requests. Honour the Retry-After header.',
          }),
        },
      },
    },
    async (req) => {
      const body = VerifyBody.parse(req.body);
      const result = await licensesService.verify({
        applicationId: req.application!.id,
        rawKey: body.key,
        machineFingerprint: body.machineFingerprint,
        ...(body.label !== undefined && { label: body.label }),
      });
      return { success: true, data: result };
    },
  );
}
