/**
 * The outbound half of the external billing provider, which is to say the
 * half that refuses.
 *
 * `getProviderForApplication` has to answer for every registered module,
 * and the code paths that dial a processor (checkout, plan registration,
 * cancellation, refunds) reach it by the name stamped on a row. A
 * subscription activated by an external system carries `provider:
 * 'external'`, so those paths will ask for this. Each answer is a
 * `RekeyError` that names the real repair instead of a TypeError from a
 * missing switch case.
 *
 * Cancellation deserves a word. The money lives in the external system, and
 * cancelling the local row without telling that system would leave the buyer
 * charged for something Rekey no longer grants. So a cancel through Rekey is
 * refused with `SUBSCRIPTION_MANAGED_EXTERNALLY`, and the external system
 * posts `subscription.canceled` when it has actually stopped billing. The two
 * best-effort callers (dunning exhaustion, end-user erasure) already catch
 * a provider error and proceed locally, which is the right outcome for
 * both: erasure must not be blocked by a system Rekey cannot reach, and a
 * subscription the sender has left past due for fourteen days is being
 * cancelled on Rekey's own dunning terms.
 */

import { createHmac } from 'node:crypto';
import type { Plan } from '@prisma/client';
import { readCappedBody } from '../../../lib/capped-body.js';
import { RekeyError } from '../../../lib/error.js';
import { assertSafeUrlResolved, pinnedFetchInit } from '../../../lib/ssrf-guard.js';
import { env } from '../../../config/env.js';
import { EXTERNAL_PROVIDER_NAME } from './modules/external/index.js';
import type {
  BillingProvider,
  CancelSubscriptionInput,
  CheckoutSessionInput,
  CheckoutSessionResult,
  ExternalSubscription,
  ProviderPlanRef,
} from './types.js';

function inboundOnly(operation: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_PROVIDER_INBOUND_ONLY',
    message: `The external billing provider cannot perform ${operation}; it only receives events.`,
    fix: 'Do this in your billing system, which then posts the resulting subscription.* event to Rekey. For self-serve checkout, connect a hosted payment provider.',
  });
}

/**
 * The one thing this provider CAN do outbound: read.
 *
 * The push direction covers everything from the moment a billing system
 * connects. It cannot cover what was sold BEFORE that, which is the entire book
 * of business on the day somebody migrates. So there is a pull: one endpoint
 * they host, which Rekey reads, paginated.
 *
 * ## The signature is deliberately NOT the webhook signature
 *
 * `signWebhook` signs `${t}.${body}` and takes no method or path. A GET has no
 * body, so reusing it verbatim would sign `${t}.` on every request, a constant
 * per second, replayable against any URL, and proof of nothing.
 *
 * This direction has its own signed string, and it binds the request:
 *
 *     v1 = HMAC-SHA256(secret, `${t}.GET.${path}${search}`)
 *
 * Same header shape (`X-Rekey-Signature: t=…,v1=…`) and the same 5-minute
 * tolerance, different payload. `docs/external-billing-pull.md` is the version
 * handed to integrators, keep the two in step, because everyone verifying this
 * is writing code against that document alone.
 */
export interface ExternalPullConfig {
  /** Where to read from. HTTPS, SSRF-guarded like any webhook target. */
  subscriptionsUrl: string;
  /** Sent as `Authorization: Bearer`. Their credential, not ours. */
  token: string;
  /** The shared secret, so they can prove the caller is Rekey. */
  signingSecret: string;
}

const PAGE_TIMEOUT_MS = 10_000;

/**
 * A page of somebody else's JSON.
 *
 * Sized against the CONTRACT, not against a typical page: the doc permits 200
 * rows each carrying up to Rekey's 16 KB metadata ceiling, so a legitimate
 * page can reach ~3.2 MB. A tighter cap would truncate that mid-object and the
 * run would die reporting malformed JSON, blaming the sender for obeying the
 * document. 8 MB leaves room for the envelope and still refuses the unbounded
 * body a bare `res.json()` would read into memory.
 */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

function pullNotConfigured(): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'EXTERNAL_PULL_NOT_CONFIGURED',
    message: 'This Application has no subscriptions endpoint configured for the external provider.',
    fix: 'Set the subscriptions URL and pull token in Panel → Application → Billing → Providers, then run the import again.',
  });
}

export class ExternalBillingProvider implements BillingProvider {
  readonly name = EXTERNAL_PROVIDER_NAME;

  constructor(private readonly pull?: ExternalPullConfig | undefined) {}

  /**
   * Read one page of their subscriptions.
   *
   * Everything here is defensive on purpose: this parses a document written by
   * somebody else's server, and a malformed row must produce a `skip_invalid`
   * item in a preview rather than a 500 in the middle of a run. Shape errors
   * are therefore left to the importer, which sees the raw row, this only
   * enforces the envelope.
   */
  async listSubscriptions(input: {
    cursor?: string | undefined;
    limit: number;
  }): Promise<{ items: ExternalSubscription[]; nextCursor?: string | undefined }> {
    if (!this.pull) throw pullNotConfigured();

    const url = new URL(this.pull.subscriptionsUrl);
    url.searchParams.set('limit', String(Math.min(Math.max(input.limit, 1), 200)));
    if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);

    // The SAME hardening the webhook delivery path uses, not merely the
    // registration-time URL check. `isWebhookUrlSafe` never resolves DNS, its
    // own module header says so, so on its own it misses a public hostname
    // with a private A record. An operator who can set this URL is not
    // necessarily trusted with the deployment's network position.
    const t = Math.floor(Date.now() / 1000);
    const signed = `${t}.GET.${url.pathname}${url.search}`;
    const v1 = createHmac('sha256', this.pull.signingSecret).update(signed).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    let res: Response;
    let bodyText: string;
    try {
      const allowed = await assertSafeUrlResolved(url.toString(), {
        allowPrivate: env.WEBHOOK_ALLOW_PRIVATE_TARGETS,
      });
      res = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.pull.token}`,
          'x-rekey-signature': `t=${t},v1=${v1}`,
          accept: 'application/json',
          'user-agent': 'Rekey (+subscription-import)',
        },
        // A validated public URL could otherwise 3xx us onto an internal host,
        // bypassing the guard above entirely.
        redirect: 'manual',
        signal: controller.signal,
        ...pinnedFetchInit(allowed),
      });
      if (res.status >= 300 && res.status < 400) {
        throw new RekeyError({
          statusCode: 400,
          code: 'EXTERNAL_PULL_URL_REFUSED',
          message: `The subscriptions endpoint redirected (${res.status}), which is not followed.`,
          fix: 'Point the configured URL directly at the endpoint. Redirects are refused because a validated public URL could otherwise forward Rekey onto an internal host.',
        });
      }
      if (!res.ok) {
        throw new RekeyError({
          statusCode: 502,
          code: 'EXTERNAL_PULL_FAILED',
          message: `The subscriptions endpoint answered ${res.status}.`,
          fix: 'A 401 usually means the pull token or the signature check disagrees. Verify both against docs/external-billing-pull.md.',
        });
      }
      // Inside the try, so the abort signal is still armed: a server that sends
      // headers and then trickles the body must hit the timeout, not hang.
      bodyText = (await readCappedBody(res, MAX_PAGE_BYTES)).text;
    } catch (e) {
      if (e instanceof RekeyError) throw e;
      throw new RekeyError({
        statusCode: 502,
        code: 'EXTERNAL_PULL_UNREACHABLE',
        message: `Could not read the subscriptions endpoint: ${(e as Error).message}`,
        fix: 'Check the URL is reachable from the Rekey deployment, is not a private address, and answers within 10 seconds.',
      });
    } finally {
      clearTimeout(timer);
    }

    let body: { items?: unknown; nextCursor?: unknown } | null;
    try {
      body = JSON.parse(bodyText) as { items?: unknown; nextCursor?: unknown };
    } catch {
      body = null;
    }
    if (body === null || !Array.isArray(body.items)) {
      throw new RekeyError({
        statusCode: 502,
        code: 'EXTERNAL_PULL_MALFORMED',
        message: 'The subscriptions endpoint did not return a JSON object with an `items` array.',
        fix: 'Return `{ "items": [...], "nextCursor": "..." }`. See docs/external-billing-pull.md.',
      });
    }
    return {
      items: body.items as ExternalSubscription[],
      ...(typeof body.nextCursor === 'string' && body.nextCursor !== ''
        ? { nextCursor: body.nextCursor }
        : {}),
    };
  }

  async ensurePlanRegistered(_plan: Plan): Promise<ProviderPlanRef> {
    throw inboundOnly('plan registration');
  }

  async createCheckoutSession(_input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    throw inboundOnly('checkout');
  }

  async createOneTimeCheckout(_input: CheckoutSessionInput): Promise<CheckoutSessionResult> {
    throw inboundOnly('checkout');
  }

  async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
    throw new RekeyError({
      statusCode: 409,
      code: 'SUBSCRIPTION_MANAGED_EXTERNALLY',
      message: 'This subscription is managed by an external billing system and cannot be cancelled here.',
      fix:
        'Cancel it in the billing system that sold it. Rekey mirrors the change when that system posts ' +
        `subscription.canceled for "${input.subscription.providerSubId ?? input.subscription.id}".`,
    });
  }
}
