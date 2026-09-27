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
 * Every send, success, error, or no_transport, is recorded in `EmailLog`
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
import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { assertSafeHost } from './ssrf-guard.js';
import { env } from '../config/env.js';
import { decryptJson } from './secrets.js';
import { prisma } from './prisma.js';
import { recordSecurityEvent } from './security-events.js';

export type EmailProvider = 'resend' | 'smtp';

/**
 * `Application.emailConfig`. `fromAddress` belongs to the BYO credentials and
 * is written with them; the other three are the sender identity, written by
 * `PATCH .../email-sender` and honoured on the shared pool too.
 */
export interface EmailConfig {
  fromAddress?: string;
  fromName?: string;
  replyTo?: string;
  /** Where recipients should write for help. Stored for templates, never a header. */
  supportEmail?: string;
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
  /**
   * Nothing was sent and the caller must withhold whatever token it minted.
   *
   * `suppressed` marks the sub-case where the refusal was a CONFIGURATION
   * CHOICE, the Application's email switch, a disabled event, or an address
   * on the suppression list, rather than a transport that broke. Callers that
   * raise a delivery-failure alarm must not raise it for this: an operator who
   * turns an event off should not then find their own activity feed filling
   * with `auth.email_delivery_failed` alerts about the thing they just did.
   */
  | { kind: 'error'; message: string; suppressed?: true };

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  /** Extra headers, e.g. List-Unsubscribe. Only the BYO transports carry them. */
  headers?: Record<string, string>;
  /** Display name for this message, over `emailConfig.fromName`. BYO transports only. */
  fromName?: string;
}

/**
 * A send that FAILED is not a send that was never attempted.
 *
 * The auth flows fall back to returning the raw token when there is no mail
 * transport (the documented "your server forwards it" contract). They used
 * to take the same branch on `{kind:'error'}`, so a lapsed Resend key or a
 * blown quota silently turned every password-reset and magic-link request
 * into a token handed back in the JSON response body, while the endpoint
 * still answered 200.
 *
 * Callers now withhold the token on `error` and call this instead. The
 * response shape must stay identical to the delivered path: only an existing
 * user triggers a send at all, so surfacing the failure would turn these
 * endpoints into email-enumeration oracles. The operator learns via the
 * EmailLog row (recorded for every outcome) plus this security event, which
 * shows up in the app's activity feed.
 */
export async function recordAuthEmailDeliveryFailure(input: {
  /** null on the operator surface, those flows aren't Application-scoped. */
  applicationId: string | null;
  /**
   * REQUIRED for the event to be visible. `listSecurityEvents` filters on
   * tenantId, so a row written without one can never be returned by the only
   * consumer, the panel's security-events page. Omitting it made the
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
  customTemplateKey?: string;
  customTemplateVersion?: number;
  /**
   * Write the outcome into this existing row instead of creating one. The
   * custom send route inserts a `pending` row first, as its idempotency lock.
   */
  logId?: string;
  /**
   * Refuse rather than fall back to the shared pool when the Application has
   * no credentials of its own. Custom templates set it: the route checks the
   * transport first, and this closes the window where credentials are removed
   * between that check and the send.
   */
  requireCustomTransport?: boolean;
}

/**
 * Coerce a decrypted credential blob into the discriminated `EmailCredentials`
 * shape. Accepts both the current discriminated form and the pre-SMTP
 * `{ resend: { apiKey } }`. Returns `null` when nothing usable is present.
 *
 * The legacy branch stays deliberately (candidate for removal in 2.0.0). The
 * blobs are encrypted with ENCRYPTION_KEY, so no SQL migration can rewrite
 * them; converting them needs a bespoke key-holding backfill script. Dropping
 * this branch fails silently: `null` falls through to the default transport,
 * so an Application whose Resend key predates the SMTP change would simply
 * stop delivering verification and password-reset mail with no error anywhere.
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
    // Malformed ciphertext is treated the same as no creds, fall back to
    // default transport. Decryption errors surface in logs when the operator
    // next inspects the panel.
    return null;
  }
}

function emailConfig(application: Application): EmailConfig {
  return (application.emailConfig ?? {}) as EmailConfig;
}

/**
 * The Application's sender identity, for anything that renders mail about it.
 *
 * @example
 * ```ts
 * const { supportEmail } = emailSenderIdentity(application);
 * ```
 */
export function emailSenderIdentity(application: Application): {
  fromName: string | null;
  replyTo: string | null;
  supportEmail: string | null;
} {
  const cfg = emailConfig(application);
  return {
    fromName: cfg.fromName ?? null,
    replyTo: cfg.replyTo ?? null,
    supportEmail: cfg.supportEmail ?? null,
  };
}

/**
 * Connect to an address the SSRF guard approved rather than to the hostname,
 * which nodemailer would resolve again and a rebinding record could answer
 * with an internal address. `servername` keeps SNI and certificate checks on
 * the hostname the operator configured.
 *
 * IPv4 first: the lookup returns addresses in resolver order, and an AAAA
 * record listed first would break sending from a host with no IPv6 route.
 */
export function pinnedSmtpHost(
  host: string,
  approvedAddresses: readonly string[],
): { host: string; servername?: string } {
  const pinned = approvedAddresses.find((a) => isIP(a) === 4) ?? approvedAddresses[0];
  if (pinned === undefined) return { host };
  return isIP(host) === 0 ? { host: pinned, servername: host } : { host: pinned };
}

/** RFC 5322 `specials`: a display name containing one must be a quoted string. */
const DISPLAY_NAME_SPECIALS = /[()<>[\]:;@\\,."]/;

/**
 * Control characters, CR and LF among them. In a header value they end the
 * header and let the rest of the value be read as new headers (`Bcc:` and the
 * like), so a stored value containing one is refused and a sent one stripped.
 */
function isControlChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** True when `value` can go into a mail header without starting a new one. */
export function isHeaderSafe(value: string): boolean {
  return ![...value].some(isControlChar);
}

/** Each run of control characters becomes one space. */
function stripHeaderControls(value: string): string {
  let out = '';
  let inRun = false;
  for (const ch of value) {
    if (isControlChar(ch)) {
      if (!inRun) out += ' ';
      inRun = true;
    } else {
      out += ch;
      inRun = false;
    }
  }
  return out;
}

/**
 * `Name <address>`, quoting the name when it contains a special. Unquoted,
 * `Acme, Inc. <a@x>` parses as two mailboxes, and a name with `<` or `@` can
 * make a client show a different sender.
 */
export function fromHeader(address: string, name: string | undefined): string {
  const clean = name === undefined ? undefined : stripHeaderControls(name).trim();
  if (!clean) return address;
  const display = DISPLAY_NAME_SPECIALS.test(clean) ? `"${clean.replace(/["\\]/g, '\\$&')}"` : clean;
  return `${display} <${address}>`;
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
          ...(input.headers !== undefined && { headers: input.headers }),
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
  // record, so this is an outbound connection to a tenant-chosen address,
  // exactly what the SSRF guard exists for. A workspace admin could point it
  // at 127.0.0.1:6379 or 169.254.169.254:80, fire a test send, and read the
  // connection outcome from the API response: an internal port scanner over
  // the public API. Apply the guard here too, not just next to the webhook
  // code where it originally lived.
  let approvedAddresses: string[];
  try {
    approvedAddresses = await assertSafeHost(creds.host);
  } catch {
    return {
      kind: 'error',
      // Deliberately fixed text. The whole value of the scanner was that the
      // message distinguished refused / timed out / wrong protocol / spoke
      // SMTP, so the message is where the fix has to land, not just the block.
      message: 'SMTP host is not an allowed destination.',
    };
  }
  try {
    const transport = nodemailer.createTransport({
      ...pinnedSmtpHost(creds.host, approvedAddresses),
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
    // timer stalls the request indefinitely, measured at 42s against a server
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
          ...(input.headers !== undefined && { headers: input.headers }),
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
 * credentials, their host, or wait, and nothing finer than that can be said
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
 * The address belongs to the deployment, so the name has to disclose that:
 * mail about "Acme" arriving from `noreply@rekey.dev` under the bare name
 * "Rekey" tells the recipient nothing about who it concerns, and under the
 * bare name "Acme" it claims a sending identity Acme does not have.
 * `Acme (via Rekey)` is the convention Google Groups and GitHub use for the
 * same situation.
 *
 * An operator's own `fromName` replaces the Application name but keeps the
 * suffix: the shared address is the deployment's, and a bare custom name there
 * would let any customer send as anyone, the deployment included. An
 * Application with BYO credentials never reaches here: that mail leaves its
 * own domain, so it goes out under its `fromName` verbatim.
 *
 * The suffix is the deployment's own name, never a hardcoded "Rekey". A
 * self-hoster's shared pool is theirs, not ours.
 */
export function pooledFromName(
  application: Application,
  /** Injectable so the rule is testable without a deployment-wide env var. */
  deploymentName: string | undefined = env.RESEND_DEFAULT_FROM_NAME,
): string | undefined {
  const deployment = deploymentName?.trim();
  const configured = emailConfig(application).fromName?.trim();
  if (configured) return deployment ? `${configured} (via ${deployment})` : configured;
  const appName = application.name?.trim();
  if (!appName) return deploymentName;
  // Nothing to disclose if the Application IS the deployment brand.
  if (!deployment || deployment.toLowerCase() === appName.toLowerCase()) return appName;
  return `${appName} (via ${deployment})`;
}

/** Send via the Rekey-managed default Resend pool. */
async function sendDefaultResend(
  input: SendInput,
  fromName: string | undefined = env.RESEND_DEFAULT_FROM_NAME,
  replyTo?: string,
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
        ...(replyTo !== undefined && { replyTo }),
      }),
    );
    if (res.error) return { kind: 'error', message: res.error.message };
    return { kind: 'sent', messageId: res.data?.id ?? null, via: 'default_resend' };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
}

/**
 * Persist an EmailLog row for a send that was deliberately NOT attempted.
 *
 * Exported so every `email_logs` write still happens in this file, the
 * invariant the table's own comment states ("Recorded at the transport boundary
 * so EVERY send is captured regardless of caller"). A suppression never reaches
 * a transport, so without this it would be the one outcome leaving no trace,
 * and "the customer never got the email" would have no answer in the single
 * place an operator looks for send outcomes.
 *
 * `status: 'suppressed'` is a fourth value alongside sent / error /
 * no_transport, and deliberately not `error`: nothing failed.
 */
export async function recordSuppressedSend(args: {
  tenantId: string | null;
  applicationId: string | null;
  to: string;
  subject: string;
  eventKey: string | null;
  reason: string;
}): Promise<void> {
  try {
    await prisma.emailLog.create({
      data: {
        tenantId: args.tenantId,
        applicationId: args.applicationId,
        toAddress: args.to.toLowerCase(),
        subject: args.subject,
        eventKey: args.eventKey,
        via: 'none',
        status: 'suppressed',
        messageId: null,
        error: args.reason,
      },
    });
  } catch {
    // Same contract as `recordLog`: a log write must never break the caller.
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
  meta?: SendLogMeta | undefined;
}): Promise<void> {
  const via = args.outcome.kind === 'sent' ? args.outcome.via : 'none';
  const status = args.outcome.kind; // 'sent' | 'no_transport' | 'error'
  const messageId = args.outcome.kind === 'sent' ? args.outcome.messageId : null;
  const error = args.outcome.kind === 'error' ? args.outcome.message : null;
  const result = { subject: args.subject, via, status, messageId, error };
  try {
    if (args.meta?.logId !== undefined) {
      await prisma.emailLog.update({ where: { id: args.meta.logId }, data: result });
      return;
    }
    await prisma.emailLog.create({
      data: {
        tenantId: args.tenantId,
        applicationId: args.applicationId,
        toAddress: args.to.toLowerCase(),
        eventKey: args.eventKey,
        customTemplateKey: args.meta?.customTemplateKey ?? null,
        customTemplateVersion: args.meta?.customTemplateVersion ?? null,
        ...result,
      },
    });
  } catch {
    // Swallow, a log write failure must never break delivery.
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
 * System-level send, tenant-scoped flows (workspace invitations, operator
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
  // callers that are NOT request-driven: dunning escalation, subscription
  // lifecycle mail, anything on a timer that would otherwise keep mailing an
  // operator's customers about a product that is switched off.
  //
  // The outcome is `error`, not `no_transport`, and that choice matters.
  // `no_transport` is the "your server forwards the token" contract: auth
  // flows take that branch by handing the raw token back in the JSON
  // response body. Returning it here would turn disabling an Application
  // into a token-disclosure path. `error` is the branch where callers
  // withhold the token, already handled by every existing consumer.
  //
  // Still logged, with the real reason in the outcome, so "why did my
  // customer not get this mail" is answerable from the email log.
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
      meta,
    });
    return outcome;
  }

  const creds = resolveCredentials(application);
  const cfg = emailConfig(application);

  let outcome: SendOutcome;
  if (!creds && meta?.requireCustomTransport === true) {
    outcome = {
      kind: 'error',
      message:
        'Not sent: this application has no email credentials of its own, and custom templates never use the shared pool.',
    };
  } else if (creds) {
    if (!cfg.fromAddress) {
      outcome = {
        kind: 'error',
        message:
          'Application has BYO email credentials but no `fromAddress` in emailConfig. Set it via Panel → Application → Email.',
      };
    } else {
      const name = input.fromName ?? cfg.fromName;
      outcome = await sendVia(creds, input, {
        address: cfg.fromAddress,
        ...(name !== undefined && { name }),
        ...(cfg.replyTo !== undefined && { replyTo: cfg.replyTo }),
      });
    }
  } else {
    // Shared pool: the recipient is told which Application this is about, and
    // that it left the deployment's domain rather than that Application's.
    // Reply-To is safe to honour here: it only decides where a reply goes, and
    // the From line above still names the deployment that sent it.
    outcome = await sendDefaultResend(input, pooledFromName(application), cfg.replyTo);
  }

  await recordLog({
    tenantId: application.tenantId,
    applicationId: application.id,
    to: input.to,
    subject: input.subject,
    eventKey: meta?.eventKey ?? null,
    outcome,
    meta,
  });
  return outcome;
}
