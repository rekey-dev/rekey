/**
 * Who a checkout bills: the buyer, or an organization they buy for.
 *
 * The subject is a property of the Application. It bills individuals or it
 * bills organizations, never both, and checkout and everything that predicts
 * a checkout refuse the same mismatches.
 */

import { RekeyError } from '../../lib/error.js';

/**
 * Refuse a checkout whose subject the Application does not bill.
 *
 * An org-billed Application must be told which organization: silently billing
 * the user instead is the mistake a new integrator makes first. A user-billed
 * one must not be handed an organization: `Subscription` is unique on
 * `(applicationId, endUserId, planId)` with no beneficiary in the key, so a
 * personal and an org-billed subscription to one plan are one row, and the
 * second would take the place of the first while it kept billing (#431).
 *
 * @example
 * assertCheckoutSubject(billingConfig.billingSubject, body.organizationId);
 */
export function assertCheckoutSubject(billingSubject: string, beneficiaryOrgId: string | undefined): void {
  if (billingSubject === 'org' && beneficiaryOrgId === undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_ORGANIZATION_REQUIRED',
      message: 'This Application bills per organization, but no organization was provided for checkout.',
      fix: 'Pass `organizationId` of a team the user OWNS or ADMINS (set the session\'s active org via organizations.switch, or pass organizationId to createCheckout). Change the model in Panel → Application → Billing → Setup → Defaults.',
    });
  }
  if (billingSubject !== 'org' && beneficiaryOrgId !== undefined) {
    throw new RekeyError({
      statusCode: 400,
      code: 'BILLING_ORGANIZATION_NOT_ACCEPTED',
      message: 'This Application bills individual users, so a checkout cannot name an organization.',
      fix: 'Drop `organizationId` to bill the user, or switch the Application to organization billing in Panel → Application → Billing → Setup → Defaults (only possible while nothing is subscribed).',
    });
  }
}
