/**
 * Guard: the calling Application must have billing enabled
 * (`billingConfig.enabled`). Runs AFTER `requireApiKey` (needs
 * `request.application`). Returns 403 `BILLING_DISABLED` otherwise.
 *
 * Gates the public billing surface (checkout, subscriptions, coupons) so an
 * app with billing turned off can't transact. The panel hides the Billing
 * group in parallel; this is the server-side enforcement.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { BillingConfigSchema } from '@rekey.dev/shared-types';
import { RekeyError } from '../lib/error.js';

export async function requireBillingEnabled(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.application) {
    throw new RekeyError({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      message: 'requireBillingEnabled ran without an Application on the request.',
      fix: 'Register requireApiKey before requireBillingEnabled on the route.',
    });
  }
  const config = BillingConfigSchema.parse(request.application.billingConfig);
  if (!config.enabled) {
    throw new RekeyError({
      statusCode: 403,
      code: 'BILLING_DISABLED',
      message: 'Billing is not enabled for this application.',
      fix: 'Enable billing in Panel → Application → Billing, then retry.',
    });
  }
}
