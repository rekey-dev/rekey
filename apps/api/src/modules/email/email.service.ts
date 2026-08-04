/**
 * Email service — the seam between an auth flow ("a reset link was just
 * minted, deliver it to the user") and the transport ("Resend
 * sent it"). Three responsibilities:
 *
 *   1. Resolve the (Application, eventKey) → template. Prefers a
 *      tenant-customised `EmailTemplate` row; falls back to the built-in
 *      defaults in `defaults/`.
 *   2. Render the subject + body with the supplied variables, escaping
 *      runtime values against template-injection / stored-XSS.
 *   3. Hand off to the transport (`lib/email-transport.ts`). The transport
 *      tells us whether it actually sent — auth flows use that to decide
 *      between "email delivered, drop the raw token" and "no transport
 *      configured, return the raw token to the API caller for them to
 *      forward it themselves."
 *
 * Templates and credentials are tenant-scoped (per Application). The
 * service never crosses Applications; callers always pass the
 * `Application` row that authorises the send.
 */

import type { Application, EmailTemplate } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import {
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
 * user input, and a bare `throw new Error` made it a 500 INTERNAL_ERROR — an
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
 * Render + send. Returns the transport outcome verbatim so callers can
 * branch on "delivered" vs "no_transport" to decide whether to expose
 * the raw token in their HTTP response.
 */
export async function dispatch(input: DispatchInput): Promise<SendOutcome> {
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
 * System-level dispatch — used by Tenant-scoped flows (workspace
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
 * Public service surface — used by both the auth flows (dispatch only)
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
   * Render a template with the event's sample values — for the panel preview
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
   * key or SMTP host/port/user/pass) — stored encrypted at rest.
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

  /** Remove BYO creds — Application falls back to the default Resend pool. */
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
   * Recent send-log rows across a whole Tenant (workspace view). Every send
   * — per-app and tenant system mail — carries the denormalised `tenantId`,
   * so a single indexed query covers both. The owning app (if any) is joined
   * for display.
   */
  async listTenantLogs(args: {
    tenantId: string;
    limit?: number;
    offset?: number;
    status?: EmailLogStatus;
    /** When true, only tenant SYSTEM mail (operator magic-link/reset, workspace
     *  invites) — i.e. sends NOT tied to an Application (applicationId null). */
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

export type EmailLogStatus = 'sent' | 'error' | 'no_transport';

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
