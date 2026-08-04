/**
 * The one refusal for "this plan has no price at the payment provider".
 *
 * Two call sites raise it and they are deliberately the same error:
 *
 *   - `plansService` — an operator trying to put an unregistered plan on sale.
 *   - the provider classes — a buyer reaching checkout for a plan whose
 *     provider price id is missing.
 *
 * The second used to be a bare `throw new Error(...)`, which the Fastify error
 * handler could only render as `INTERNAL_ERROR` / 500 "An unexpected error
 * occurred." The condition is neither unexpected nor internal: it is a known,
 * named, operator-fixable state, and collapsing it to a 500 meant the only
 * description of what was wrong lived in a server log the buyer's operator was
 * not reading. `fix` is written for the OPERATOR even though a buyer may be the
 * one who sees it — they are the only party who can act on it.
 *
 * Its own module so both sides can share it: `plans.service.ts` already imports
 * from `billing/providers/`, so the reverse import has to stay dependency-free.
 */

import { RekeyError } from '../../lib/error.js';

export function planNotRegisteredError(args: {
  planSlug: string;
  provider: string;
  /** Present at the operator call sites; omitted where only the plan is known. */
  applicationId?: string;
}): RekeyError {
  const path = args.applicationId
    ? `/api/v1/tenant/applications/${args.applicationId}/plans/${args.planSlug}/register`
    : '/api/v1/tenant/applications/:id/plans/:slug/register';
  return new RekeyError({
    // 409, not 500: nothing failed. The plan is in a state that conflicts with
    // being bought, it will stay that way until someone changes it, and a retry
    // of the same request cannot help.
    statusCode: 409,
    code: 'PLAN_NOT_REGISTERED_WITH_PROVIDER',
    message: `Plan "${args.planSlug}" is not registered with ${args.provider}, so it cannot be purchased.`,
    fix: `The Application operator must register it: POST ${path} (Panel → Application → Plans → Register). If registration was refused because the ${args.provider} credentials were wrong, correct them under Panel → Application → Billing first. Plan details can be corrected with PATCH on the same plan while it is unregistered.`,
  });
}
