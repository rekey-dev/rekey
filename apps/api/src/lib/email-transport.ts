/**
 * Email delivery transport.
 *
 * Per-Application transport is chosen at send time:
 *
 *   1. BYO credentials on `Application.emailCredentialsCiphertext` →
 *      send via the Application's own provider (Resend API or SMTP) using
 *      the operator-configured `from` address from `emailConfig`.
 *
 *   2. `RESEND_DEFAULT_API_KEY` env set → send via the Rekey-managed
 *      Resend pool using `RESEND_DEFAULT_FROM`. Hosted Rekey turns this
 *      on; self-hosters leave it off.
 *
 *   3. Neither → return `{ kind: 'no_transport' }`. The auth flows that
 *      consume this (forgot-password, verify-email) fall back to the
 *      legacy "return the raw token to the API caller" behaviour.
 *
 * Every send — success, error, or no_transport — is recorded in `EmailLog`
 * at this boundary (see `recordLog`) so the panel's per-app / per-tenant
 * log views capture all mail regardless of which caller invoked us. Logging
 * never throws into the send path.
 *
 * Providers: Resend (HTTP API) and SMTP (nodemailer). SMTP covers SES /
 * Postmark / SendGrid / Mailgun / Gmail / custom relays via their SMTP
 * endpoints. The decrypted credential shape is a discriminated union keyed
 * by `provider`; a legacy ciphertext of `{ resend: { apiKey } }` (no
 * discriminator) is normalised to `{ provider: 'resend', apiKey }`.
 */

import type { Application } from '@prisma/client';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { assertSafeHost } from './ssrf-guard.js';
import { env } from '../config/env.js';
import { decryptJson } from './secrets.js';
import { prisma } from './prisma.js';
import { recordSecurityEvent } from './security-events.js';

export type EmailProvider = 'resend' | 'smtp';

export interface EmailConfig {
  fromAddress?: string;
  fromName?: string;
  replyTo?: string;
}

/**
 * Decrypted BYO credentials, discriminated by `provider`. Stored encrypted in
 * `Application.emailCredentialsCiphertext`.
 */
export type EmailCredentials =
  | { provider: 'resend'; apiKey: string }
  | {
      provider: 'smtp';
      host: string;
      port: number;
      /** true = implicit TLS (465); false = STARTTLS (587). */
      secure: boolean;
      user: string;
      pass: string;
    };

export type SentVia = 'byo_resend' | 'byo_smtp' | 'default_resend';

/**
 * Outbound budget per send attempt, matching the billing providers'
 * PAYPAL_TIMEOUT_MS / RAZORPAY_TIMEOUT_MS convention and rationale: these
 * sends are awaited inline on auth request paths (the outcome decides whether
 * the raw token is returned), and the SMTP host is a tenant-supplied address.
 * Without a budget, nodemailer's defaults are 2 min connect / 10 min socket,
 * so one slow or tarpit SMTP server holds every sign-up, password-reset and
 * magic-link request for that Application open for minutes each. A timeout
 * surfaces as `{kind:'error'}`, which every auth caller already handles
 * safely (token withheld, delivery-failure security event recorded,
 * enumeration-safe response shape preserved).
 */
const EMAIL_TIMEOUT_MS = 10_000;

/**
 * Race a send against the budget. The Resend SDK (v6) exposes no per-request
 * abort option on `emails.send`, so the race is the available mechanism; the
 * losing HTTP call is abandoned to settle in the background. The timeout
 * message is deliberately fixed text: it is persisted to EmailLog.error and
 * returned by the test-send route, both tenant-readable, so it must not
 * describe the network (same rule as classifySmtpError below).
 */
async function withEmailDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Email send timed out.')),
      EMAIL_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export type SendOutcome =
  | { kind: 'sent'; messageId: string | null; via: SentVia }
  | { kind: 'no_transport' }
  | { kind: 'error'; message: string };

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * A send that FAILED is not a send that was never attempted.
 *
 * The auth flows fall back to returning the raw token when there is no mail
 * transport — that's the documented "your server forwards it" contract. They
 * used to take the same branch on `{kind:'error'}`, so a lapsed Resend key or a
 * blown quota silently turned every password-reset and magic-link request into
 * a token handed back in the JSON body: straight into request logs, error
 * trackers, and anything else recording responses, while the endpoint still
 * answered 200 and nobody noticed.
 *
 * Callers now withhold the token on `error` and call this instead. The response
 * shape must stay IDENTICAL to the delivered path: only an existing user
 * triggers a send at all, so surfacing the failure to the caller would turn
 * these endpoints into email-enumeration oracles. The operator learns about it
 * out of band — the EmailLog row (recorded for every outcome, including this
 * one) plus this security event, which shows up in the app's activity feed.
 */
export async function recordAuthEmailDeliveryFailure(input: {
  /** null on the operator surface — those flows aren't Application-scoped. */
  applicationId: string | null;
  /**
   * REQUIRED for the event to be visible. `listSecurityEvents` filters on
   * tenantId, so a row written without one can never be returned by the only
   * consumer — the panel's security-events page. Omitting it made the
   * compensating control this whole fix leans on unobservable.
   */
  tenantId: string | null;
  eventKey: string;
  endUserId?: string | null;
  reason: string;
}): Promise<void> {
  await recordSecurityEvent({
    type: 'auth.email_delivery_failed',
    actorType: 'system',
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    ...(input.endUserId ? { actorId: input.endUserId } : {}),
    metadata: {
      eventKey: input.eventKey,
      // Transport's own message; no token or recipient address.
      reason: input.reason.slice(0, 500),
      consequence: 'token_withheld',
    },
  });
}

/** Optional metadata threaded into the EmailLog row. */
export interface SendLogMeta {
  /** Email event key (e.g. "verify_email"); null/omitted for ad-hoc sends. */
  eventKey?: string | null;
}

/**
 * Coerce a decrypted credential blob into the discriminated `EmailCredentials`
 * shape. Accepts both the current discriminated form and the pre-SMTP
 * `{ resend: { apiKey } }`. Returns `null` when nothing usable is present.
 *
 * The legacy branch is KEPT deliberately (reviewed for removal in 2.0.0). The
 * blobs are encrypted with ENCRYPTION_KEY, so no SQL migration can rewrite
 * them — conversion would need a bespoke key-holding backfill script. And the
 * failure mode of dropping it is silent: `null` here falls through to the
 * default transport, so an Application whose Resend key was stored before the
 * SMTP change would simply stop delivering its own verification and
 * password-reset mail with no error anywhere. Six lines is cheaper than that.
 */
export function normalizeCredentials(raw: unknown): EmailCredentials | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.provider === 'string') {
    if (o.provider === 'resend' && typeof o.apiKey === 'string' && o.apiKey.length > 0) {
      return { provider: 'resend', apiKey: o.apiKey };
    }
    if (
      o.provider === 'smtp' &&
      typeof o.host === 'string' &&
      typeof o.port === 'number' &&
      typeof o.user === 'string' &&
      typeof o.pass === 'string'
    ) {
      return {
        provider: 'smtp',
        host: o.host,
        port: o.port,
        secure: o.secure !== false, // default to implicit TLS unless explicitly false
        user: o.user,
        pass: o.pass,
      };
    }
    return null;
  }

  // Legacy shape: { resend: { apiKey } }.
  const legacy = o.resend as { apiKey?: unknown } | undefined;
  if (legacy && typeof legacy.apiKey === 'string' && legacy.apiKey.length > 0) {
    return { provider: 'resend', apiKey: legacy.apiKey };
  }
  return null;
}

function resolveCredentials(application: Application): EmailCredentials | null {
  if (!application.emailCredentialsCiphertext) return null;
  try {
    return normalizeCredentials(decryptJson<unknown>(application.emailCredentialsCiphertext));
  } catch {
    // Malformed ciphertext is treated the same as no creds — fall back to
    // default transport. Decryption errors surface in logs when the operator
    // next inspects the panel.
    return null;
  }
}

function emailConfig(application: Application): EmailConfig {
  return (application.emailConfig ?? {}) as EmailConfig;
}

function fromHeader(address: string, name: string | undefined): string {
  if (!name) return address;
  return `${name} <${address}>`;
}

interface FromIdentity {
  address: string;
  name?: string;
  replyTo?: string;
}

/** Send via a resolved BYO credential set. */
async function sendVia(
  creds: EmailCredentials,
  input: SendInput,
  from: FromIdentity,
): Promise<SendOutcome> {
  if (creds.provider === 'resend') {
    try {
      const client = new Resend(creds.apiKey);
      const res = await withEmailDeadline(
        client.emails.send({
          from: fromHeader(from.address, from.name),
          to: input.to,
          subject: input.subject,
          html: input.html,
          ...(input.text !== undefined && { text: input.text }),
          ...(from.replyTo !== undefined && { replyTo: from.replyTo }),
        }),
      );
      if (res.error) return { kind: 'error', message: res.error.message };
      return { kind: 'sent', messageId: res.data?.id ?? null, via: 'byo_resend' };
    } catch (e) {
      return { kind: 'error', message: (e as Error).message };
    }
  }

  // SMTP (nodemailer). Covers SES/Postmark/SendGrid/Mailgun/custom relays.
  //
  // The host and port come straight from an operator-supplied credential
  // record, so this is an outbound connection to a tenant-chosen address —
  // exactly what the SSRF guard exists for, and it was not applied here. A
  // workspace admin could point it at 127.0.0.1:6379 or 169.254.169.254:80,
  // fire a test send, and read the connection outcome out of the API response:
  // an internal port scanner over the public API. The guard lived next to the
  // webhook code rather than next to *outbound connections*, which is why an
  // equally tenant-controlled destination four modules away never got it.
  try {
    await assertSafeHost(creds.host);
  } catch {
    return {
      kind: 'error',
      // Deliberately fixed text. The whole value of the scanner was that the
      // message distinguished refused / timed out / wrong protocol / spoke
      // SMTP — so the message is where the fix has to land, not just the block.
      message: 'SMTP host is not an allowed destination.',
    };
  }
  try {
    const transport = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.secure,
      auth: { user: creds.user, pass: creds.pass },
      // Tenant-chosen host: without these, nodemailer waits 2 min to connect
      // and 10 min on a silent socket. Timeouts surface as ETIMEDOUT/ESOCKET,
      // which classifySmtpError already maps to tenant-safe text.
      connectionTimeout: EMAIL_TIMEOUT_MS,
      greetingTimeout: EMAIL_TIMEOUT_MS,
      socketTimeout: EMAIL_TIMEOUT_MS,
    });
    // The nodemailer timeouts above are PER-PHASE, not a total budget:
    // `socketTimeout` is an inactivity timer. An SMTP conversation is about
    // seven round trips, so a host that answers every command just under the
    // timer stalls the request indefinitely — measured at 42s against a server
    // that never idled more than 6s. That is precisely the tarpit this module
    // exists to bound, and it is the tenant-supplied host, the one we control
    // least. The total deadline has to wrap the send itself.
    let info;
    try {
      info = await withEmailDeadline(
        transport.sendMail({
          from: fromHeader(from.address, from.name),
          to: input.to,
          subject: input.subject,
          html: input.html,
          ...(input.text !== undefined && { text: input.text }),
          ...(from.replyTo !== undefined && { replyTo: from.replyTo }),
        }),
      );
    } catch (e) {
      // Abandoning the promise leaves the socket open against a host that is
      // already misbehaving; close it rather than holding a connection per
      // stalled request.
      transport.close();
      throw e;
    }
    return { kind: 'sent', messageId: info.messageId ?? null, via: 'byo_smtp' };
  } catch (e) {
    // Classified, not verbatim. This string is returned by the test-send route
    // and persisted to EmailLog.error, both of which the tenant can read, so a
    // raw nodemailer error ("connect ECONNREFUSED 127.0.0.1:6379") reports the
    // state of an internal port back to whoever asked. The full error still
    // goes to the server log.
    return { kind: 'error', message: classifySmtpError(e) };
  }
}

/**
 * A tenant-safe description of why an SMTP send failed.
 *
 * Deliberately coarse: an operator needs to know whether to fix their
 * credentials, their host, or wait — and nothing finer than that can be said
 * without describing the network to someone who chose the address.
 */
function classifySmtpError(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  const responseCode = (e as { responseCode?: number }).responseCode;
  if (code === 'EAUTH' || responseCode === 535) {
    return 'SMTP authentication was rejected — check the username and password.';
  }
  if (code === 'EENVELOPE') return 'SMTP server rejected the sender or recipient address.';
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION') {
    return 'Could not establish an SMTP connection — check the host, port and TLS setting.';
  }
  return 'SMTP send failed.';
}

/**
 * The display name an Application's mail goes out under when it is riding the
 * shared pool rather than its own credentials.
 *
 * The address belongs to the deployment, so the name has to disclose that: mail
 * about "Acme" arriving from `noreply@rekey.dev` under the bare name "Rekey"
 * tells the recipient nothing about who it concerns, and under the bare name
 * "Acme" it claims a sending identity Acme does not have. `Acme (via Rekey)` is
 * the convention Google Groups and GitHub use for the same situation, and it is
 * the honest reading of what actually happened.
 *
 * An operator who sets their own `fromName` gets it verbatim — this is only the
 * default. An Application with BYO credentials never reaches here at all: that
 * mail leaves their own domain, so there is nothing to disclose.
 *
 * The suffix is the deployment's own name, never a hardcoded "Rekey" — a
 * self-hoster's shared pool is theirs, not ours.
 */
export function pooledFromName(
  application: Application,
  /** Injectable so the rule is testable without a deployment-wide env var. */
  deploymentName: string | undefined = env.RESEND_DEFAULT_FROM_NAME,
): string | undefined {
  const configured = emailConfig(application).fromName;
  if (configured) return configured;
  const appName = application.name?.trim();
  if (!appName) return deploymentName;
  const deployment = deploymentName?.trim();
  // Nothing to disclose if the Application IS the deployment brand.
  if (!deployment || deployment.toLowerCase() === appName.toLowerCase()) return appName;
  return `${appName} (via ${deployment})`;
}

/** Send via the Rekey-managed default Resend pool. */
async function sendDefaultResend(
  input: SendInput,
  fromName: string | undefined = env.RESEND_DEFAULT_FROM_NAME,
): Promise<SendOutcome> {
  if (!env.RESEND_DEFAULT_API_KEY || !env.RESEND_DEFAULT_FROM) {
    return { kind: 'no_transport' };
  }
  try {
    const client = new Resend(env.RESEND_DEFAULT_API_KEY);
    // Same budget as the BYO path: operator flows (workspace invites, operator
    // password reset) await this inline on unauthenticated endpoints too.
    const res = await withEmailDeadline(
      client.emails.send({
        from: fromHeader(env.RESEND_DEFAULT_FROM, fromName),
        to: input.to,
        subject: input.subject,
        html: input.html,
        ...(input.text !== undefined && { text: input.text }),
      }),
    );
    if (res.error) return { kind: 'error', message: res.error.message };
    return { kind: 'sent', messageId: res.data?.id ?? null, via: 'default_resend' };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
}

/** Persist one EmailLog row. Never throws into the send path. */
async function recordLog(args: {
  tenantId: string | null;
  applicationId: string | null;
  to: string;
  subject: string;
  eventKey: string | null;
  outcome: SendOutcome;
}): Promise<void> {
  const via = args.outcome.kind === 'sent' ? args.outcome.via : 'none';
  const status = args.outcome.kind; // 'sent' | 'no_transport' | 'error'
  const messageId = args.outcome.kind === 'sent' ? args.outcome.messageId : null;
  const error = args.outcome.kind === 'error' ? args.outcome.message : null;
  try {
    await prisma.emailLog.create({
      data: {
        tenantId: args.tenantId,
        applicationId: args.applicationId,
        toAddress: args.to.toLowerCase(),
        subject: args.subject,
        eventKey: args.eventKey,
        via,
        status,
        messageId,
        error,
      },
    });
  } catch {
    // Swallow — a log write failure must never break delivery.
  }
}

/**
 * Decide which transport an Application would use, without sending. Used by
 * the panel's "email status" surface and by tests.
 */
export function describeTransport(application: Application): {
  via: SentVia | 'none';
  provider: EmailProvider | 'default' | 'none';
  fromAddress: string | null;
} {
  const creds = resolveCredentials(application);
  const cfg = emailConfig(application);

  if (creds) {
    return {
      via: creds.provider === 'resend' ? 'byo_resend' : 'byo_smtp',
      provider: creds.provider,
      fromAddress: cfg.fromAddress ?? null,
    };
  }
  if (env.RESEND_DEFAULT_API_KEY && env.RESEND_DEFAULT_FROM) {
    return { via: 'default_resend', provider: 'default', fromAddress: env.RESEND_DEFAULT_FROM };
  }
  return { via: 'none', provider: 'none', fromAddress: null };
}

/**
 * System-level send — tenant-scoped flows (workspace invitations, operator
 * MFA) with no `Application`. Default Resend pool only. Pass `tenantId` so the
 * send shows in that tenant's email-log view.
 */
export async function sendEmailSystem(
  input: SendInput,
  meta?: { eventKey?: string | null; tenantId?: string | null },
): Promise<SendOutcome> {
  const outcome = await sendDefaultResend(input);
  await recordLog({
    tenantId: meta?.tenantId ?? null,
    applicationId: null,
    to: input.to,
    subject: input.subject,
    eventKey: meta?.eventKey ?? null,
    outcome,
  });
  return outcome;
}

export async function sendEmail(
  application: Application,
  input: SendInput,
  meta?: SendLogMeta,
): Promise<SendOutcome> {
  // A disabled Application sends no mail. Its end-user-facing routes are
  // already refused at both API-key middlewares, so in practice this catches
  // the callers that are NOT request-driven — dunning escalation, subscription
  // lifecycle mail, anything on a timer — which would otherwise keep mailing
  // an operator's customers about a product that is switched off.
  //
  // The outcome is `error`, and the choice matters more than it looks.
  // `no_transport` is the documented "your server forwards the token" contract
  // (see the note below): auth flows take that branch by handing the RAW token
  // back in the JSON response body. Returning it here would turn disabling an
  // Application into a token-disclosure path. `error` is the branch where
  // callers withhold the token, which is the correct behaviour for a send that
  // was deliberately not attempted, and it is already handled by every
  // existing consumer — no fourth union member, so no consumer goes unaudited.
  //
  // Still logged, with the real reason in the outcome, because "why did my
  // customer not get this mail" must be answerable from the email log rather
  // than by reading this function.
  if (application.disabledAt !== null) {
    const outcome: SendOutcome = {
      kind: 'error',
      message: 'Not sent: this application is disabled. Re-enable it to resume sending.',
    };
    await recordLog({
      tenantId: application.tenantId,
      applicationId: application.id,
      to: input.to,
      subject: input.subject,
      eventKey: meta?.eventKey ?? null,
      outcome,
    });
    return outcome;
  }

  const creds = resolveCredentials(application);
  const cfg = emailConfig(application);

  let outcome: SendOutcome;
  if (creds) {
    if (!cfg.fromAddress) {
      outcome = {
        kind: 'error',
        message:
          'Application has BYO email credentials but no `fromAddress` in emailConfig. Set it via Panel → Application → Email.',
      };
    } else {
      outcome = await sendVia(creds, input, {
        address: cfg.fromAddress,
        ...(cfg.fromName !== undefined && { name: cfg.fromName }),
        ...(cfg.replyTo !== undefined && { replyTo: cfg.replyTo }),
      });
    }
  } else {
    // Shared pool: the recipient is told which Application this is about, and
    // that it left the deployment's domain rather than that Application's.
    outcome = await sendDefaultResend(input, pooledFromName(application));
  }

  await recordLog({
    tenantId: application.tenantId,
    applicationId: application.id,
    to: input.to,
    subject: input.subject,
    eventKey: meta?.eventKey ?? null,
    outcome,
  });
  return outcome;
}
