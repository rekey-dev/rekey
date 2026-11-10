/**
 * The email that carries an organization invitation's link to the invited
 * address, in the Application's branding (the `organization_invitation` event,
 * overridable per Application like every built-in email).
 */

import type { Application } from '@prisma/client';
import { buildTokenUrl, defaultAuthLinkPage } from '../../lib/app-url.js';
import { recordAuthEmailDeliveryFailure } from '../../lib/email-transport.js';
import { emailService } from '../email/email.service.js';
import { applicationEmailScope, mayMailUnattended } from '../email/auth-email-caps.js';

const BUILT_IN_ROLE_NAMES: Readonly<Record<string, string>> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };

/**
 * Where the invitation's button points: the caller's `inviteUrl` with the
 * token in place of `{token}` (checked against the Application's own origins
 * by the route), else the app's own `/accept-invitation` page on its resolved
 * base URL, else its hosted portal's `/invitation-link`. Empty when none of
 * those exists.
 *
 * @example
 * invitationLink(app, 'tok', undefined); // 'https://portal.rekey.dev/acme/invitation-link?token=tok'
 */
export function invitationLink(application: Application, rawToken: string, inviteUrl: string | undefined): string {
  if (inviteUrl !== undefined) return inviteUrl.replace('{token}', encodeURIComponent(rawToken));
  return buildTokenUrl(defaultAuthLinkPage(application, 'invitation'), '', rawToken);
}

/**
 * Mail the invitation. Returns whether it went out.
 *
 * Counted against the recipient's auth-email cap like any other mail nobody
 * asked for by address: over the cap, with no link page, or with the event
 * switched off, nothing is sent and the invitation still stands, so the
 * inviter can share the link from the API's response.
 */
export async function mailInvitation(args: {
  application: Application;
  to: string;
  rawToken: string;
  inviteUrl: string | undefined;
  inviterEmail: string;
  organizationName: string;
  role: string;
  expiresAt: Date;
}): Promise<boolean> {
  const inviteUrl = invitationLink(args.application, args.rawToken, args.inviteUrl);
  if (inviteUrl === '') return false;
  if (!(await mayMailUnattended(applicationEmailScope(args.application), args.to))) return false;
  const outcome = await emailService.dispatch({
    application: args.application,
    eventKey: 'organization_invitation',
    to: args.to,
    variables: {
      inviteeEmail: args.to,
      inviterEmail: args.inviterEmail,
      organizationName: args.organizationName,
      roleName: BUILT_IN_ROLE_NAMES[args.role] ?? args.role,
      inviteUrl,
      expiresAtIso: args.expiresAt.toISOString(),
    },
  });
  if (outcome.kind === 'error' && !outcome.suppressed) {
    void recordAuthEmailDeliveryFailure({
      applicationId: args.application.id,
      tenantId: args.application.tenantId,
      eventKey: 'organization_invitation',
      reason: outcome.message,
    });
  }
  return outcome.kind === 'sent';
}
