/**
 * Email service, the seam between an auth flow ("a reset link was just
 * minted, deliver it to the user") and the transport ("Resend
 * sent it"). Three responsibilities:
 *
 *   1. Resolve the (Application, eventKey) → template. Prefers a
 *      tenant-customised `EmailTemplate` row; falls back to the built-in
 *      defaults in `defaults/`.
 *   2. Render the subject + body with the supplied variables, escaping
 *      runtime values against template-injection / stored-XSS.
 *   3. Hand off to the transport (`lib/email-transport.ts`). The transport
 *      tells us whether it actually sent, auth flows use that to decide
 *      between "email delivered, drop the raw token" and "no transport
 *      configured, return the raw token to the API caller for them to
 *      forward it themselves."
 *
 * Templates and credentials are tenant-scoped (per Application). The
 * service never crosses Applications; callers always pass the
 * `Application` row that authorises the send.
 */

import type { Application, EmailSuppression, EmailTemplate, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
  recordSuppressedSend,
  sendEmail,
  sendEmailSystem,
  type SendOutcome,
  type EmailCredentials,
} from '../../lib/email-transport.js';
import {
  EMAIL_EVENTS,
  isKnownEvent,
  type EmailEventKey,
} from './events.js';
import { DEFAULT_TEMPLATES } from './defaults/index.js';
import {
  renderTemplate,
  renderHtmlBody,
  pickEventVariables,
  htmlToPlainText,
} from './render.js';

export interface ResolvedTemplate {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  /** True when this came from an EmailTemplate row, false for built-in default. */
  customised: boolean;
}

async function resolveTemplate(
  applicationId: string,
  eventKey: EmailEventKey,
): Promise<ResolvedTemplate> {
  const row = await prisma.emailTemplate.findUnique({
    where: { applicationId_eventKey: { applicationId, eventKey } },
  });
  if (row) {
    return {
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      bodyText: row.bodyText,
      customised: true,
    };
  }
  const def = DEFAULT_TEMPLATES[eventKey];
  return {
    subject: def.subject,
    bodyHtml: def.html,
    bodyText: def.text ?? null,
    customised: false,
  };
}

export interface RenderResult {
  subject: string;
  html: string;
  text: string;
  customised: boolean;
}

/**
 * An `eventKey` that is not in the registry.
 *
 * Every one of these reaches the service from a URL path segment, so it is
 * user input, and a bare `throw new Error` made it a 500 INTERNAL_ERROR, an
 * operator typing a stale event name got "something went wrong on our end" and
 * a page in the error log. The two routes that already parsed the segment
 * themselves answered 404 EMAIL_EVENT_UNKNOWN; the preview and test-send routes
 * did not, and passed it straight through. Same code and status as those two,
 * because a third answer for the same bad input on the same resource is just
 * another thing to look up.
 */
function unknownEmailEvent(eventKey: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'EMAIL_EVENT_UNKNOWN',
    message: `Email event "${eventKey}" is not in the registry.`,
    fix: 'Use one of the events returned by GET /api/v1/tenant/applications/:id/email-templates.',
  });
}

/**
 * Render a template without sending. Used by the panel's preview pane and
 * by tests that want to assert template output.
 */
export async function renderForEvent(
  applicationId: string,
  eventKey: string,
  variables: Record<string, unknown>,
): Promise<RenderResult> {
  if (!isKnownEvent(eventKey)) {
    throw unknownEmailEvent(eventKey);
  }
  const tpl = await resolveTemplate(applicationId, eventKey);
  const vars = pickEventVariables(eventKey, variables);
  const subject = renderTemplate(tpl.subject, vars, { escape: false });
  const html = renderHtmlBody(tpl.bodyHtml, vars);
  const text = tpl.bodyText
    ? renderTemplate(tpl.bodyText, vars, { escape: false })
    : htmlToPlainText(html);
  return { subject, html, text, customised: tpl.customised };
}

export interface DispatchInput {
  application: Application;
  eventKey: EmailEventKey;
  to: string;
  variables: Record<string, unknown>;
}

/**
 * Why a send did not happen, when the reason is configuration rather than
 * failure. Broadest first; that is also the order they are checked in.
 */
export type SuppressionReason = 'application_disabled' | 'event_disabled' | 'suppressed_address';

const SUPPRESSION_TEXT: Record<SuppressionReason, string> = {
  application_disabled: 'All email is switched off for this Application.',
  event_disabled: 'This email event is switched off for this Application.',
  suppressed_address: 'This address is on the Application suppression list.',
};

/**
 * Events that never pass through `dispatch`, so no per-Application switch can
 * reach them. Rendering a control for these would let an operator turn
 * something "off" that keeps arriving.
 */
const SYSTEM_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  'workspace_invitation',
  'billing_unapplied_payment',
]);

/**
 * The events a live auth method can depend on. `essentialBlocker` decides,
 * per event, whether the current config does; this is the list it is asked
 * about when the whole Application's email is being switched off.
 */
const ESSENTIAL_EVENTS: readonly EmailEventKey[] = [
  'password_reset',
  'magic_link_signin',
  'email_verification',
];

/**
 * Serialise every writer on the email/auth-config coupling for one Application.
 *
 * The coupling is checked from both ends by two services: the email switches
 * refuse to go off while the auth config needs mail, and the auth-config
 * update refuses an email-dependent method while mail is off. Each reads the
 * other's state and then writes. Without a shared lock, "email off" and
 * "password sign-in on" can each pass against the other's old value, and both
 * commit: password sign-in with no reset path, which neither check allows.
 *
 * A row lock on the Application, taken first inside the transaction, and every
 * check re-read under it. All three writers (master switch, per-event switch,
 * auth-config update) must take it. A lock only one door takes serialises
 * nothing.
 *
 * `FOR NO KEY UPDATE`, not `FOR UPDATE`. Every child insert that references
 * the Application (an end user at sign-up, a refresh token at rotation) takes
 * `FOR KEY SHARE` on this row through its foreign key, and `FOR UPDATE`
 * conflicts with that, so an operator flipping an email switch stalled every
 * sign-up for the Application until the switch committed. `FOR NO KEY UPDATE`
 * still conflicts with itself, which is all the three writers need, and the
 * columns they write (`emailsEnabled`, `authConfig`) are not key columns, so
 * the lock is never upgraded.
 */
export async function lockEmailCoupling(
  tx: Prisma.TransactionClient,
  applicationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId} FOR NO KEY UPDATE`;
}

/**
 * Is this send allowed out at all? Cheapest and broadest gate first, so a
 * silenced Application costs one boolean rather than three queries.
 */
async function suppressionFor(
  application: Application,
  eventKey: EmailEventKey,
  to: string,
): Promise<SuppressionReason | null> {
  if (application.emailsEnabled === false) return 'application_disabled';

  const [setting, suppressed] = await Promise.all([
    prisma.emailEventSetting.findUnique({
      where: { applicationId_eventKey: { applicationId: application.id, eventKey } },
      select: { enabled: true },
    }),
    prisma.emailSuppression.findUnique({
      where: { applicationId_address: { applicationId: application.id, address: to.toLowerCase() } },
      select: { id: true },
    }),
  ]);
  // A MISSING row means enabled: applying this feature must not silence
  // anything until an operator says so.
  if (setting !== null && setting.enabled === false) return 'event_disabled';
  if (suppressed !== null) return 'suppressed_address';
  return null;
}

/**
 * Is this address on the Application's suppression list, and why?
 *
 * Separate from `suppressionFor` because the test-send route needs exactly
 * this one gate and deliberately not the other two: it must work while
 * sending is switched off (that is how an operator proves a new transport
 * before turning it back on), but it must not mail an address that
 * hard-bounced or complained.
 */
export async function addressSuppression(
  applicationId: string,
  to: string,
): Promise<{ reason: string } | null> {
  return prisma.emailSuppression.findUnique({
    where: { applicationId_address: { applicationId, address: to.toLowerCase() } },
    select: { reason: true },
  });
}

/**
 * Render + send, unless something says not to.
 *
 * Returns the transport outcome verbatim so callers can branch on "delivered"
 * vs "no_transport" to decide whether to expose the raw token in their HTTP
 * response, with the one deliberate exception documented at the gate below.
 */
export async function dispatch(input: DispatchInput): Promise<SendOutcome> {
  const suppression = await suppressionFor(input.application, input.eventKey, input.to);
  if (suppression !== null) {
    // Logged, so the Delivery view can answer "why did they not get it", the
    // whole point of a switch you can see the effect of.
    await recordSuppressedSend({
      tenantId: input.application.tenantId,
      applicationId: input.application.id,
      to: input.to,
      subject: `[suppressed] ${input.eventKey}`,
      eventKey: input.eventKey,
      reason: SUPPRESSION_TEXT[suppression],
    });
    // `error`, NOT `no_transport`, and the distinction is load-bearing.
    //
    // `no_transport` is the documented contract that hands the RAW TOKEN back
    // to the caller, so a self-hoster with no email can deliver it themselves
    // (see the reset and magic-link paths). Reporting a suppression that way
    // would quietly turn "we switched email off" into "the API now returns live
    // password-reset tokens in its responses", not a trade anybody asked for,
    // and not one they would notice.
    //
    // Every existing caller already treats `error` as "nothing sent, withhold
    // the token", so this is the safe shape without touching 40 branch sites.
    return {
      kind: 'error',
      message: `Email suppressed: ${SUPPRESSION_TEXT[suppression]}`,
      // So the auth paths can tell "the operator switched this off" from "the
      // transport broke" and skip the delivery-failure alarm for the former.
      suppressed: true,
    };
  }

  const rendered = await renderForEvent(
    input.application.id,
    input.eventKey,
    input.variables,
  );
  return sendEmail(
    input.application,
    {
      to: input.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    },
    { eventKey: input.eventKey },
  );
}

/**
 * System-level dispatch, used by Tenant-scoped flows (workspace
 * invitations, operator MFA notifications) where there's no Application
 * to bind per-tenant template customisation or BYO Resend creds to.
 *
 * Uses the built-in default template for the event and the
 * RESEND_DEFAULT_* transport pool. Returns `no_transport` on self-hosted
 * deploys that don't configure the env, so callers fall back to the
 * legacy token-return contract.
 */
export async function dispatchSystem(input: {
  eventKey: import('./events.js').EmailEventKey;
  to: string;
  variables: Record<string, unknown>;
  /** Owning tenant, so the send appears in that workspace's email-log view. */
  tenantId?: string | null;
}): Promise<SendOutcome> {
  const def = DEFAULT_TEMPLATES[input.eventKey];
  const vars = pickEventVariables(input.eventKey, input.variables);
  const subject = renderTemplate(def.subject, vars, { escape: false });
  const html = renderHtmlBody(def.html, vars);
  const text = def.text
    ? renderTemplate(def.text, vars, { escape: false })
    : htmlToPlainText(html);
  return sendEmailSystem(
    { to: input.to, subject, html, text },
    { eventKey: input.eventKey, tenantId: input.tenantId ?? null },
  );
}

/**
 * Public service surface, used by both the auth flows (dispatch only)
 * and the tenant routes (CRUD on templates).
 */
export const emailService = {
  renderForEvent,
  dispatch,
  dispatchSystem,

  /** List event keys + which ones have a custom row on this Application. */
  async listEvents(applicationId: string): Promise<
    Array<{ key: EmailEventKey; label: string; customised: boolean }>
  > {
    const customs = await prisma.emailTemplate.findMany({
      where: { applicationId },
      select: { eventKey: true },
    });
    const customised = new Set(customs.map((r) => r.eventKey));
    return Object.values(EMAIL_EVENTS).map((e) => ({
      key: e.key,
      label: e.label,
      customised: customised.has(e.key),
    }));
  },

  /**
   * Get the current template (custom or default). The panel hydrates the
   * builder from this.
   */
  async getTemplate(
    applicationId: string,
    eventKey: string,
  ): Promise<
    | (ResolvedTemplate & { designJson: unknown | null; variables: readonly string[] })
    | null
  > {
    if (!isKnownEvent(eventKey)) return null;
    const tpl = await resolveTemplate(applicationId, eventKey);
    const row = tpl.customised
      ? await prisma.emailTemplate.findUnique({
          where: { applicationId_eventKey: { applicationId, eventKey } },
          select: { designJson: true },
        })
      : null;
    return {
      ...tpl,
      designJson: row?.designJson ?? null,
      variables: EMAIL_EVENTS[eventKey].variables,
    };
  },

  /** Upsert the tenant's customised template. `designJson` is opaque to us. */
  async setTemplate(args: {
    applicationId: string;
    eventKey: string;
    subject: string;
    designJson: unknown;
    bodyHtml: string;
    bodyText?: string | null;
  }): Promise<EmailTemplate> {
    if (!isKnownEvent(args.eventKey)) {
      throw unknownEmailEvent(args.eventKey);
    }
    return prisma.emailTemplate.upsert({
      where: {
        applicationId_eventKey: {
          applicationId: args.applicationId,
          eventKey: args.eventKey,
        },
      },
      create: {
        applicationId: args.applicationId,
        eventKey: args.eventKey,
        subject: args.subject,
        designJson: args.designJson as never,
        bodyHtml: args.bodyHtml,
        ...(args.bodyText !== undefined && { bodyText: args.bodyText }),
      },
      update: {
        subject: args.subject,
        designJson: args.designJson as never,
        bodyHtml: args.bodyHtml,
        ...(args.bodyText !== undefined && { bodyText: args.bodyText }),
      },
    });
  },

  async deleteTemplate(applicationId: string, eventKey: string): Promise<void> {
    if (!isKnownEvent(eventKey)) return;
    await prisma.emailTemplate.deleteMany({
      where: { applicationId, eventKey },
    });
  },

  /**
   * Render a template with the event's sample values, for the panel preview
   * and the test-send route. Both take `eventKey` from the URL, so an unknown
   * one is a 404, not a 500.
   */
  async previewWithSamples(applicationId: string, eventKey: string): Promise<RenderResult> {
    if (!isKnownEvent(eventKey)) {
      throw unknownEmailEvent(eventKey);
    }
    return renderForEvent(applicationId, eventKey, EMAIL_EVENTS[eventKey].sampleValues);
  },

  /**
   * Configure (or rotate) the Application's BYO transport creds + email
   * config. `credentials` is the discriminated provider union (Resend API
   * key or SMTP host/port/user/pass), stored encrypted at rest.
   */
  async setCredentials(args: {
    applicationId: string;
    credentials: EmailCredentials;
    fromAddress: string;
    fromName?: string | null;
    replyTo?: string | null;
  }): Promise<void> {
    const { encryptJson } = await import('../../lib/secrets.js');
    const ciphertext = encryptJson(args.credentials);
    const emailConfig = {
      fromAddress: args.fromAddress,
      ...(args.fromName != null && { fromName: args.fromName }),
      ...(args.replyTo != null && { replyTo: args.replyTo }),
    };
    await prisma.application.update({
      where: { id: args.applicationId },
      data: {
        emailCredentialsCiphertext: ciphertext,
        emailConfig: emailConfig as never,
      },
    });
  },

  // ---- Send control: the master switch, per-event switches, suppressions ----

  /**
   * Whether an event may be switched off, and what breaks if it is.
   *
   * Three of the nine events are load-bearing: turning one off silently removes
   * the only way a user completes a flow the Application still offers. So they
   * are coupled to the auth config rather than merely warned about, the switch
   * is refused while the flow that depends on it is live, and the refusal names
   * the setting to change first.
   *
   * This is the same fail-closed shape the rest of the codebase uses for
   * "configuration that contradicts itself", and it is preferable to a warning
   * because the person disabling `password_reset` at 2am is not reading a
   * warning.
   */
  async essentialBlocker(
    application: Application,
    eventKey: EmailEventKey,
  ): Promise<{ code: string; message: string; fix: string } | null> {
    const auth = (application.authConfig ?? {}) as {
      methods?: string[];
      requireEmailVerification?: boolean;
    };
    const methods = auth.methods ?? [];

    if (eventKey === 'password_reset' && methods.includes('password')) {
      return {
        code: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG',
        message:
          'Password sign-in is enabled, so the password-reset email is the only way a user who forgets their password gets back in.',
        fix: 'Turn off password sign-in first (Application → Authentication → Methods), or leave this event enabled.',
      };
    }
    if (eventKey === 'magic_link_signin' && methods.includes('magic_link')) {
      return {
        code: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG',
        message:
          'Magic-link sign-in is enabled, and the magic-link email IS that sign-in method. Disabling it makes the method unusable while it is still offered.',
        fix: 'Turn off magic-link sign-in first (Application → Authentication → Methods), or leave this event enabled.',
      };
    }
    if (eventKey === 'email_verification' && auth.requireEmailVerification === true) {
      return {
        code: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG',
        message:
          'Email verification is required for sign-in, so this email is the only route into a new account.',
        fix: 'Turn off "require email verification" first (Application → Authentication), or leave this event enabled.',
      };
    }
    return null;
  },

  /**
   * The SAME coupling, read from the other end.
   *
   * `essentialBlocker` refuses to disable an email the live auth config needs.
   * That is only half a guarantee, because the auth config can move too: turn
   * `requireEmailVerification` off, disable the `email_verification` email
   * (now permitted), turn verification back on, three ordinary steps, and
   * every subsequent sign-up is stranded on a screen waiting for a mail that
   * will never be sent, with nothing anywhere reporting a problem.
   *
   * So the auth-config route asks this before it writes. Returns the blockers
   * that the PATCHED config would create, or an empty array.
   *
   * The master switch counts as every event being off. `dispatch` checks
   * `emailsEnabled` before it looks at any per-event row, so an Application
   * with all email off and password sign-in on has no reset path at all,
   * whatever the `password_reset` row says. `cause` tells the caller which
   * switch to name in its fix: the master one, or the event's own.
   */
  async authConfigBlockers(
    applicationId: string,
    next: { methods?: string[] | undefined; requireEmailVerification?: boolean | undefined },
    db: Prisma.TransactionClient = prisma,
  ): Promise<Array<{ eventKey: string; message: string; cause: 'master_switch' | 'event_switch' }>> {
    const wanted: Array<[EmailEventKey, boolean, string]> = [
      [
        'password_reset',
        (next.methods ?? []).includes('password'),
        'Password sign-in needs the password-reset email: it is the only way a user who forgets their password gets back in, and that email is switched off for this Application.',
      ],
      [
        'magic_link_signin',
        (next.methods ?? []).includes('magic_link'),
        'Magic-link sign-in IS the magic-link email, and that email is switched off for this Application.',
      ],
      [
        'email_verification',
        next.requireEmailVerification === true,
        'Requiring email verification needs the verification email, and that email is switched off for this Application, every new sign-up would be stranded.',
      ],
    ];
    const needed = wanted.filter(([, want]) => want).map(([key]) => key);
    if (needed.length === 0) return [];
    // Sequential rather than Promise.all: `db` may be an interactive
    // transaction, which runs one query at a time on one connection.
    const application = await db.application.findUniqueOrThrow({
      where: { id: applicationId },
      select: { emailsEnabled: true },
    });
    const settings = await db.emailEventSetting.findMany({
      where: { applicationId, eventKey: { in: needed }, enabled: false },
      select: { eventKey: true },
    });
    if (application.emailsEnabled === false) {
      return wanted
        .filter(([, want]) => want)
        .map(([eventKey, , message]) => ({ eventKey, message, cause: 'master_switch' as const }));
    }
    const off = new Set(settings.map((r) => r.eventKey));
    return wanted
      .filter(([key, want]) => want && off.has(key))
      .map(([eventKey, , message]) => ({ eventKey, message, cause: 'event_switch' as const }));
  },

  addressSuppression,

  /** Master switch + every event's state, for the settings screen. */
  async getSendControl(application: Application): Promise<{
    emailsEnabled: boolean;
    events: Array<{
      key: EmailEventKey;
      label: string;
      enabled: boolean;
      customised: boolean;
      essentialBlocker: { code: string; message: string; fix: string } | null;
      /**
       * True where the event is only ever sent by `dispatchSystem`, which has
       * no per-Application gate. The switch would render, the operator would
       * turn it off, and the mail would keep going, so the UI marks these
       * rather than offering a control that does nothing.
       */
      systemScoped: boolean;
    }>;
  }> {
    const [settings, customs] = await Promise.all([
      prisma.emailEventSetting.findMany({ where: { applicationId: application.id } }),
      prisma.emailTemplate.findMany({
        where: { applicationId: application.id },
        select: { eventKey: true },
      }),
    ]);
    const disabled = new Set(settings.filter((s) => !s.enabled).map((s) => s.eventKey));
    const customised = new Set(customs.map((c) => c.eventKey));

    const events = await Promise.all(
      (Object.keys(EMAIL_EVENTS) as EmailEventKey[]).map(async (key) => ({
        key,
        label: EMAIL_EVENTS[key].label,
        enabled: !disabled.has(key),
        customised: customised.has(key),
        essentialBlocker: await this.essentialBlocker(application, key),
        systemScoped: SYSTEM_SCOPED_EVENTS.has(key),
      })),
    );
    return { emailsEnabled: application.emailsEnabled, events };
  },

  /**
   * The master switch is refused under the same rule as a per-event switch.
   *
   * `dispatch` tests `emailsEnabled` before any per-event row, so turning it
   * off silences the password-reset, magic-link and verification emails
   * whatever their own switches say. Refusing `password_reset` alone while
   * password sign-in is live, and then letting one boolean switch it off
   * anyway, would be a lock on the door next to an open window. Same code as
   * the per-event refusal, so a client that handles one handles both; the
   * blockers are listed so the fix names every method that has to go first.
   */
  async setEmailsEnabled(applicationId: string, enabled: boolean): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await lockEmailCoupling(tx, applicationId);
      if (!enabled) {
        // Re-read under the lock: the auth config read before it is exactly
        // the stale value a concurrent auth-config write would invalidate.
        const application = await tx.application.findUniqueOrThrow({
          where: { id: applicationId },
        });
        const blockers = (
          await Promise.all(
            ESSENTIAL_EVENTS.map((key) => this.essentialBlocker(application, key)),
          )
        ).filter((b): b is NonNullable<typeof b> => b !== null);
        if (blockers.length > 0) {
          throw new RekeyError({
            statusCode: 409,
            code: 'EMAIL_EVENT_REQUIRED_BY_AUTH_CONFIG',
            message: `All email cannot be switched off while the auth config depends on it. ${blockers
              .map((b) => b.message)
              .join(' ')}`,
            fix: blockers.map((b) => b.fix).join(' '),
          });
        }
      }
      await tx.application.update({
        where: { id: applicationId },
        data: { emailsEnabled: enabled },
      });
    });
  },

  /** Refuses to disable an event the live auth config still depends on. */
  async setEventEnabled(
    application: Application,
    eventKey: EmailEventKey,
    enabled: boolean,
  ): Promise<void> {
    // Refuse rather than store a setting nothing reads. These events go out
    // through `dispatchSystem`, which has no per-Application gate, so a stored
    // `enabled: false` here would leave an operator certain they had switched
    // something off while it kept arriving, the worst kind of switch.
    // Only the DISABLE is refused. Re-enabling has to stay possible, or an
    // Application carrying a stale `enabled: false` row from before these two
    // events were recognised as workspace-scoped could never have it cleared.
    if (!enabled && SYSTEM_SCOPED_EVENTS.has(eventKey)) {
      throw new RekeyError({
        statusCode: 409,
        code: 'EMAIL_EVENT_NOT_APPLICATION_SCOPED',
        message: `"${eventKey}" is sent by Rekey to your workspace, not by this Application to its end-users, so an Application-level switch does not reach it.`,
        fix: 'Workspace notifications are not configurable per Application. Nothing to change here.',
      });
    }
    await prisma.$transaction(async (tx) => {
      await lockEmailCoupling(tx, application.id);
      if (!enabled) {
        // The caller's `application` was read before the lock; decide on the
        // row as it stands now.
        const current = await tx.application.findUniqueOrThrow({ where: { id: application.id } });
        const blocker = await this.essentialBlocker(current, eventKey);
        if (blocker) {
          throw new RekeyError({ statusCode: 409, ...blocker });
        }
      }
      await tx.emailEventSetting.upsert({
        where: { applicationId_eventKey: { applicationId: application.id, eventKey } },
        create: { applicationId: application.id, eventKey, enabled },
        update: { enabled },
      });
    });
  },

  async listSuppressions(
    applicationId: string,
    opts: { take?: number; skip?: number } = {},
  ): Promise<{ items: EmailSuppression[]; total: number }> {
    const where = { applicationId };
    const [items, total] = await Promise.all([
      prisma.emailSuppression.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...(opts.take !== undefined && { take: opts.take }),
        ...(opts.skip !== undefined && { skip: opts.skip }),
      }),
      prisma.emailSuppression.count({ where }),
    ]);
    return { items, total };
  },

  /** Idempotent on (application, address), re-adding updates the note. */
  async addSuppression(args: {
    applicationId: string;
    address: string;
    reason: string;
    note?: string | undefined;
    createdBy: string | null;
  }): Promise<EmailSuppression> {
    const address = args.address.trim().toLowerCase();
    return prisma.emailSuppression.upsert({
      where: { applicationId_address: { applicationId: args.applicationId, address } },
      create: {
        applicationId: args.applicationId,
        address,
        reason: args.reason,
        ...(args.note !== undefined && { note: args.note }),
        createdBy: args.createdBy,
      },
      update: {
        reason: args.reason,
        ...(args.note !== undefined && { note: args.note }),
      },
    });
  },

  /** Idempotent: removing an address that is not suppressed answers false. */
  async removeSuppression(applicationId: string, address: string): Promise<boolean> {
    const result = await prisma.emailSuppression.deleteMany({
      where: { applicationId, address: address.trim().toLowerCase() },
    });
    return result.count > 0;
  },

  /** Send outcomes over a window, for the Email overview. */
  async sendStats(
    applicationId: string,
    sinceHours: number,
  ): Promise<{ sent: number; error: number; noTransport: number; suppressed: number }> {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const rows = await prisma.emailLog.groupBy({
      by: ['status'],
      where: { applicationId, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const by = (s: string): number => rows.find((r) => r.status === s)?._count._all ?? 0;
    return {
      sent: by('sent'),
      error: by('error'),
      noTransport: by('no_transport'),
      suppressed: by('suppressed'),
    };
  },

  /** Remove BYO creds, Application falls back to the default Resend pool. */
  async removeCredentials(applicationId: string): Promise<void> {
    await prisma.application.update({
      where: { id: applicationId },
      data: { emailCredentialsCiphertext: null },
    });
  },

  // ---- Email logs (read-only; powers the panel's per-app + per-tenant views) ----

  /** Recent send-log rows for one Application. */
  async listAppLogs(args: {
    applicationId: string;
    limit?: number;
    offset?: number;
    status?: EmailLogStatus;
  }): Promise<EmailLogRow[]> {
    const rows = await prisma.emailLog.findMany({
      where: {
        applicationId: args.applicationId,
        ...(args.status && { status: args.status }),
      },
      orderBy: { createdAt: 'desc' },
      take: args.limit ?? 100,
      ...(args.offset !== undefined ? { skip: args.offset } : {}),
    });
    return rows.map(shapeLog);
  },

  /** Total send-log rows matching `listAppLogs`, ignoring limit/offset. */
  async countAppLogs(args: {
    applicationId: string;
    status?: EmailLogStatus;
  }): Promise<number> {
    return prisma.emailLog.count({
      where: {
        applicationId: args.applicationId,
        ...(args.status && { status: args.status }),
      },
    });
  },

  /**
   * Recent send-log rows across a whole Tenant (workspace view). Every send,
   * per-app and tenant system mail, carries the denormalised `tenantId`,
   * so a single indexed query covers both. The owning app (if any) is joined
   * for display.
   */
  async listTenantLogs(args: {
    tenantId: string;
    limit?: number;
    offset?: number;
    status?: EmailLogStatus;
    /** When true, only tenant SYSTEM mail (operator magic-link/reset, workspace
     *  invites), i.e. sends NOT tied to an Application (applicationId null). */
    systemOnly?: boolean;
  }): Promise<Array<EmailLogRow & { application: { id: string; name: string; slug: string } | null }>> {
    const rows = await prisma.emailLog.findMany({
      where: {
        tenantId: args.tenantId,
        ...(args.systemOnly ? { applicationId: null } : {}),
        ...(args.status && { status: args.status }),
      },
      include: { application: { select: { id: true, name: true, slug: true } } },
      orderBy: { createdAt: 'desc' },
      take: args.limit ?? 100,
      ...(args.offset !== undefined ? { skip: args.offset } : {}),
    });
    return rows.map((r) => ({
      ...shapeLog(r),
      application: r.application
        ? { id: r.application.id, name: r.application.name, slug: r.application.slug }
        : null,
    }));
  },

  /** Total send-log rows matching `listTenantLogs`, ignoring limit/offset. */
  async countTenantLogs(args: {
    tenantId: string;
    status?: EmailLogStatus;
    systemOnly?: boolean;
  }): Promise<number> {
    return prisma.emailLog.count({
      where: {
        tenantId: args.tenantId,
        ...(args.systemOnly ? { applicationId: null } : {}),
        ...(args.status && { status: args.status }),
      },
    });
  },
};

export type EmailLogStatus = 'sent' | 'error' | 'no_transport' | 'suppressed';

export interface EmailLogRow {
  id: string;
  applicationId: string | null;
  toAddress: string;
  subject: string;
  eventKey: string | null;
  via: string;
  status: string;
  messageId: string | null;
  error: string | null;
  createdAt: Date;
}

function shapeLog(r: {
  id: string;
  applicationId: string | null;
  toAddress: string;
  subject: string;
  eventKey: string | null;
  via: string;
  status: string;
  messageId: string | null;
  error: string | null;
  createdAt: Date;
}): EmailLogRow {
  return {
    id: r.id,
    applicationId: r.applicationId,
    toAddress: r.toAddress,
    subject: r.subject,
    eventKey: r.eventKey,
    via: r.via,
    status: r.status,
    messageId: r.messageId,
    error: r.error,
    createdAt: r.createdAt,
  };
}

export type { EmailEventKey } from './events.js';
export type { EmailCredentials } from '../../lib/email-transport.js';
