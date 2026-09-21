import * as React from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Badge } from '@/components/Badge';
import type { BillingProviderDescriptor } from '@/lib/api';

/**
 * Setup guidance for an inbound-only billing provider (`capabilities.checkout`
 * false): the operator's own billing system posting what it sold.
 *
 * There is no dashboard to register a webhook in. The "webhook" is code the
 * operator writes, so this card gives them the three things that code needs
 * (the endpoint, the signing recipe, the event names) and asks for a `ping`
 * first: a ping that lands as `processed` in the inbound log proves the
 * secret, the URL and the signature all agree before any sale depends on
 * them. The signing scheme is the one Rekey uses for the webhooks it sends,
 * so an integrator who already verifies those can reuse the same helper in
 * the other direction.
 */
export function ExternalIngressSetup({
  descriptor,
  ingressUrl,
  configured,
}: {
  descriptor: BillingProviderDescriptor;
  ingressUrl: string | null;
  configured: boolean;
}): React.JSX.Element {
  if (!ingressUrl) {
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5">
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">Endpoint unavailable</p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300/90">
          <code className="font-mono">NEXT_PUBLIC_API_URL</code> (the public API origin) is not set on
          the panel deployment, so the endpoint URL cannot be built. Ask your admin to set it to your
          public API origin (e.g. <code className="font-mono">https://api.yourdomain.com</code>) and
          redeploy, then return here.
        </p>
      </div>
    );
  }

  const sample = JSON.stringify({
    eventId: 'evt_0001',
    type: 'ping',
    occurredAt: '2026-01-01T00:00:00Z',
    data: {},
  });
  const curl = [
    `body='${sample}'`,
    't=$(date +%s)',
    `sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | sed 's/^.* //')`,
    `curl -X POST '${ingressUrl}' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -H "x-rekey-signature: t=$t,v1=$sig" \\`,
    '  --data "$body"',
  ].join('\n');
  const events = [
    'ping',
    'subscription.activated',
    'subscription.canceled',
    'subscription.past_due',
    'payment.succeeded',
    'payment.failed',
    'payment.refunded',
  ];

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--color-fg)]">Event ingress</span>
        {configured ? (
          <Badge tone="success" dot>configured</Badge>
        ) : (
          <Badge tone="warning" dot>not set up</Badge>
        )}
      </div>
      <p className="text-xs text-[var(--color-muted-fg)]">
        {descriptor.label} hosts no checkout. Your billing system posts signed events here; Rekey
        verifies each one with the signing secret, records it in the inbound log, and activates,
        renews or cancels subscriptions from it. A subscriber Rekey has not seen is created from the
        event, so a sale can land before the person ever signs in.
      </p>

      <ol className="space-y-2 text-xs text-[var(--color-muted-fg)]">
        <li className="flex gap-2">
          <Dot n={1} />
          <span>
            Generate a secret with{' '}
            <code className="rounded bg-[var(--color-surface-muted)] px-1 py-0.5 font-mono text-[11px] text-[var(--color-fg)]">
              openssl rand -hex 32
            </code>
            , save it above, and store the same value in your billing system.
          </span>
        </li>
        <li className="flex gap-2">
          <Dot n={2} />
          <div className="min-w-0 flex-1 space-y-1">
            <span>Post events to:</span>
            <div className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono"
                title={ingressUrl}
              >
                {ingressUrl}
              </code>
              <CopyButton value={ingressUrl} label="Copy" />
            </div>
          </div>
        </li>
        <li className="flex gap-2">
          <Dot n={3} />
          <div className="min-w-0 flex-1 space-y-1">
            <span>Sign every request over the raw body, the same scheme as the webhooks Rekey sends you:</span>
            <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono text-[var(--color-fg)]">
              {'X-Rekey-Signature: t=<unix seconds>,v1=<hex>\nv1 = HMAC-SHA256(secret, "<t>.<raw body>")'}
            </pre>
            <span>A timestamp more than five minutes off is refused, so sign at send time.</span>
          </div>
        </li>
        <li className="flex gap-2">
          <Dot n={4} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span>
                Send a <code className="font-mono text-[11px] text-[var(--color-fg)]">ping</code> first. It appears
                in the inbound log below as <span className="font-medium text-[var(--color-fg)]">processed</span>{' '}
                when the secret, URL and signature agree:
              </span>
              <CopyButton value={curl} label="Copy" />
            </div>
            <pre className="overflow-x-auto rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono text-[var(--color-fg)]">
              {curl}
            </pre>
          </div>
        </li>
        <li className="flex gap-2">
          <Dot n={5} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <span>
              Then post <code className="font-mono text-[11px] text-[var(--color-fg)]">subscription.activated</code> on
              every sale, renewal and plan change, and the others as they happen. Unknown types are
              acknowledged and ignored.
            </span>
            <div className="flex flex-wrap gap-1">
              {events.map((e) => (
                <code
                  key={e}
                  className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--color-fg)]"
                >
                  {e}
                </code>
              ))}
            </div>
          </div>
        </li>
      </ol>
      <p className="text-xs text-[var(--color-muted-fg)]">
        Field-by-field reference for each event:{' '}
        <a className="underline" href={descriptor.docsUrl} target="_blank" rel="noreferrer">
          external billing guide
        </a>
        .
      </p>
    </div>
  );
}

function Dot({ n }: { n: number }): React.JSX.Element {
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[10px] font-semibold text-[var(--color-primary)]">
      {n}
    </span>
  );
}
