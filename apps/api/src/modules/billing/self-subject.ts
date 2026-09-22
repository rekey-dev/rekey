/**
 * The billing subject a signed-in end-user's own usage and credit reads
 * (`GET /usage/remaining`, `GET /credits/me/ledger`) resolve to, as a credit /
 * usage subject.
 *
 * A thin shape adapter over `billingSubjectOrganization`, the one rule every
 * self billing read shares (`/billing/entitlements`, the feature check,
 * `/users/me/licenses`, `/auth/me?include=`), with the explicit
 * `?organizationId=` handled the way those routes handle it.
 */

import type { FastifyRequest } from 'fastify';
import { organizationsService } from '../organizations/organizations.service.js';
import { billingSubjectOrganization } from './session-reads.js';

export type SelfBillingSubject = { endUserId: string } | { organizationId: string };

/**
 * - `?organizationId=` given: that organization, member-only (403
 *   `ORGANIZATION_NOT_MEMBER` otherwise), as `GET /billing/entitlements` does.
 * - Otherwise `billingSubjectOrganization`: the active organization only in an
 *   Application with `billingSubject: "org"` while the caller is a member;
 *   else the caller's personal pool.
 *
 * Must run after `requireUserSession`.
 */
export async function resolveSelfBillingSubject(
  req: FastifyRequest,
  explicitOrganizationId: string | undefined,
): Promise<SelfBillingSubject> {
  const application = req.application!;
  const endUserId = req.endUser!.id;
  if (explicitOrganizationId) {
    await organizationsService.requireMembership({
      application,
      actorEndUserId: endUserId,
      organizationId: explicitOrganizationId,
    });
    return { organizationId: explicitOrganizationId };
  }
  const organizationId = await billingSubjectOrganization(application, {
    applicationId: application.id,
    endUserId,
    activeOrganizationId: req.activeOrganizationId,
  });
  return organizationId ? { organizationId } : { endUserId };
}
