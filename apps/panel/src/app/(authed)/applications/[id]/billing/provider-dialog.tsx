import * as React from 'react';
import type { BillingProviderDescriptor } from '@/lib/api';
import { CopyButton } from '@/components/CopyButton';
import { ApiErrorText } from '@/components/api-error';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { Modal } from '@/components/Modal';
import { BillingModeAutodetect } from '@/components/BillingModeAutodetect';
import { ExternalIngressSetup } from '@/components/ExternalIngressSetup';
import { Badge } from '@/components/Badge';
import { savedStateKey } from '@/lib/saved-state-key';
import { saveProviderCredentials } from './actions';
import { BILLING_ERR as ERR } from './shared';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]';

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-[var(--color-fg)]">{label}</span>
      {children}
      {hint && <span className="block text-xs text-[var(--color-muted-fg)]">{hint}</span>}
    </label>
  );
}

interface WebhookMeta {
  dashboardPath: string;
  events: string[];
  /** What the operator pastes back into Rekey after creating the webhook. */
  returnLabel: string;
  /** Intro copy for manual-only providers (capabilities.autoWebhookRegister: false). */
  manualIntro?: string;
}

/**
 * Per-provider webhook setup COPY for the built-in three, dashboard click
 * paths and event lists live in the panel, not the registry (they're prose,
 * not contract). Whether a provider is auto-configurable comes from the
 * discovery `capabilities.autoWebhookRegister`, and unknown providers fall
 * back to a generic docsUrl-driven recipe (`webhookMetaFor`).
 */
const WEBHOOK_META: Record<string, WebhookMeta> = {
  stripe: {
    dashboardPath: 'Stripe Dashboard → Developers → Webhooks → Add endpoint',
    events: [
      'checkout.session.completed',
      'checkout.session.async_payment_succeeded',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
    ],
    returnLabel: 'Copy the signing secret (whsec_…) Stripe shows, paste it below.',
  },
  paypal: {
    dashboardPath: 'PayPal Developer Dashboard → your App → Webhooks',
    events: [
      'BILLING.SUBSCRIPTION.ACTIVATED',
      'BILLING.SUBSCRIPTION.CANCELLED',
      'BILLING.SUBSCRIPTION.SUSPENDED',
      'BILLING.SUBSCRIPTION.EXPIRED',
      'PAYMENT.SALE.COMPLETED',
      'PAYMENT.SALE.DENIED',
    ],
    returnLabel: 'Copy the generated Webhook ID, paste it below.',
  },
  razorpay: {
    dashboardPath: 'Razorpay Dashboard → Settings → Webhooks → Add New Webhook',
    events: [
      'subscription.activated',
      'subscription.charged',
      'subscription.cancelled',
      'subscription.completed',
      'subscription.halted',
      'payment_link.paid',
    ],
    returnLabel: 'Set a secret on the webhook, then enter the SAME secret below.',
    manualIntro:
      'Unlike Stripe and PayPal, Razorpay has no API to create webhooks, so there’s no Auto-configure button for it. It’s a quick one-time setup in the Razorpay dashboard:',
  },
};

/** Webhook copy for a provider, panel-curated where we have it, docsUrl-generic otherwise. */
function webhookMetaFor(d: BillingProviderDescriptor): WebhookMeta {
  return (
    WEBHOOK_META[d.name] ?? {
      dashboardPath: `the ${d.label} dashboard's webhook settings (see ${d.docsUrl})`,
      events: [],
      returnLabel: `Paste the webhook secret / id ${d.label} gives you into the field above.`,
      manualIntro: `${d.label} has no API to create webhooks, so there’s no Auto-configure button for it. It’s a quick one-time setup in the ${d.label} dashboard:`,
    }
  );
}

/**
 * Webhook setup guidance for one provider. Replaces the old raw URL + inline
 * event-code dump with a numbered, copy-first flow. Pure server component,
 * the auto/manual split uses a native <details> so it needs no client JS.
 */
function WebhookSetup({
  descriptor,
  webhookUrl,
  configured,
}: {
  descriptor: BillingProviderDescriptor;
  webhookUrl: string | null;
  configured: boolean;
}): React.JSX.Element {
  const label = descriptor.label;
  const meta = webhookMetaFor(descriptor);

  // No public base URL → no usable endpoint to paste. Surface the blocker.
  if (!webhookUrl) {
    return (
      <div className="rounded-lg border border-amber-300 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5">
        <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
          Webhook endpoint unavailable
        </p>
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300/90">
          <code className="font-mono">NEXT_PUBLIC_API_URL</code> (the public API origin) isn’t set on
          the panel deployment, so the {label} webhook URL can’t be built. Ask your admin to set it to
          your public API origin (e.g. <code className="font-mono">https://api.yourdomain.com</code>)
          and redeploy, then return here.
        </p>
      </div>
    );
  }

  const manualSteps = (
    <ol className="space-y-2 text-xs text-[var(--color-muted-fg)]">
      <li className="flex gap-2">
        <StepDot n={1} />
        <span>
          Open <span className="font-medium text-[var(--color-fg)]">{meta.dashboardPath}</span>.
        </span>
      </li>
      <li className="flex gap-2">
        <StepDot n={2} />
        <div className="min-w-0 flex-1 space-y-1">
          <span>Paste this as the endpoint / callback URL:</span>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-[var(--color-surface-muted)] px-2 py-1.5 text-[11px] font-mono" title={webhookUrl}>
              {webhookUrl}
            </code>
            <CopyButton value={webhookUrl} label="Copy" />
          </div>
        </div>
      </li>
      <li className="flex gap-2">
        <StepDot n={3} />
        <span>{meta.returnLabel}</span>
      </li>
      {meta.events.length > 0 && (
        <li className="flex gap-2">
          <StepDot n={4} />
          <div className="min-w-0 flex-1 space-y-1.5">
            <span>Subscribe to these events:</span>
            <div className="flex flex-wrap gap-1">
              {meta.events.map((e) => (
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
      )}
    </ol>
  );

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-muted)_40%,transparent)] p-3 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-[var(--color-fg)]">Webhook</span>
        {configured ? (
          <Badge tone="success" dot>configured</Badge>
        ) : (
          <Badge tone="warning" dot>not set up</Badge>
        )}
      </div>
      <p className="text-xs text-[var(--color-muted-fg)]">
        {label} tells Rekey when payments succeed or subscriptions change. Without a webhook,
        checkouts complete but nothing is fulfilled.
      </p>

      {descriptor.capabilities.autoWebhookRegister ? (
        <>
          <div className="rounded-md border border-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-primary)_5%,transparent)] px-2.5 py-2">
            <p className="text-xs font-medium text-[var(--color-fg)]">Recommended: one click</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              Save your API keys below, then hit <span className="font-medium">Auto-configure</span>{' '}
              in the providers table. Rekey creates the webhook and stores its secret for you. No
              dashboard steps, so leave the secret field blank.
            </p>
          </div>
          <details className="group">
            <summary className="cursor-pointer list-none text-xs font-medium text-[var(--color-primary)] hover:underline">
              Prefer to set it up by hand?
            </summary>
            <div className="mt-2 border-t border-[var(--color-border)] pt-2.5">{manualSteps}</div>
          </details>
        </>
      ) : (
        <>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-2">
            <p className="text-xs font-medium text-[var(--color-fg)]">Manual setup only</p>
            <p className="mt-0.5 text-xs text-[var(--color-muted-fg)]">
              {meta.manualIntro ??
                `${label} has no API to create webhooks. Set it up once in the ${label} dashboard:`}
            </p>
          </div>
          {manualSteps}
        </>
      )}
    </div>
  );
}

function StepDot({ n }: { n: number }): React.JSX.Element {
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] text-[10px] font-semibold text-[var(--color-primary)]">
      {n}
    </span>
  );
}

/**
 * Per-provider configure / rotate Modal. Same chrome (Modal trigger button +
 * label + hint Field rows) matches the rest of the panel. Trigger label
 * flips between "Configure" and "Edit" based on whether creds exist.
 *
 * Fully discovery-driven (P4): the credential inputs render from the
 * module's `credentialFields`, secret fields become password inputs, the
 * field `help` (or `pattern.message`) becomes the hint, and the submit
 * action is the ONE generic `saveProviderCredentials`.
 */
export function ProviderEditModal({
  descriptor,
  applicationId,
  webhookUrl,
  error, errorDetail, errorFix,
}: {
  descriptor: BillingProviderDescriptor;
  applicationId: string;
  webhookUrl: string | null;
  error: string | undefined;
  errorDetail?: string | undefined;
  errorFix?: string | undefined;
}): React.JSX.Element {
  const { name: provider, label, credentialFields } = descriptor;
  const inbound = descriptor.capabilities.checkout === false;
  const existing = descriptor.status;
  const action = saveProviderCredentials.bind(
    null,
    applicationId,
    provider,
    credentialFields.map((f) => f.key),
    Boolean(existing),
  );

  return (
    <Modal
      size="lg"
      modalKey="edit"
      modalValue={provider}
      title={`${existing ? 'Edit' : 'Configure'} ${label}`}
      description={
        inbound
          ? existing
            ? 'Rotate the signing secret. Leave it blank to keep the stored value.'
            : 'Connect your own billing system. It signs every event with this secret, which is stored encrypted and never shown again.'
          : existing
            ? 'Rotate keys or change routing. Leave a field blank to keep its stored value.'
            : `Connect your ${label} account. Credentials are stored encrypted and never shown again.`
      }
      trigger={existing ? 'Edit' : 'Configure'}
      triggerClassName="cursor-pointer rounded text-xs font-medium text-[var(--color-fg)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
    >
      <ActionForm
        key={savedStateKey({
          mode: existing?.mode,
          countries: existing?.countries,
          priority: existing?.priority,
        })}
        action={action}
        className="space-y-3"
      >
        {error && (
          <p role="alert" className="rounded-md border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
            <ApiErrorText code={error} detail={errorDetail} fix={errorFix} map={ERR} fallback={error} />
          </p>
        )}

        {credentialFields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.help ?? f.pattern?.message}>
            <input
              type={f.secret ? 'password' : 'text'}
              name={f.key}
              // Nothing is required on an edit: a blank field means "keep the
              // stored value", and marking it required blocks submission in the
              // browser before the request is ever made.
              required={!f.optional && !existing}
              autoComplete="off"
              {...(f.placeholder !== undefined && { placeholder: f.placeholder })}
              className={`${inputCls} font-mono`}
            />
          </Field>
        ))}

        {/* Webhook setup, numbered, copy-first; auto-configure where supported.
            An inbound-only provider has no dashboard, so it gets the ingress
            recipe instead. */}
        {inbound ? (
          <ExternalIngressSetup
            descriptor={descriptor}
            ingressUrl={webhookUrl}
            configured={existing?.webhookConfigured ?? false}
          />
        ) : (
          <WebhookSetup
            descriptor={descriptor}
            webhookUrl={webhookUrl}
            configured={existing?.webhookConfigured ?? false}
          />
        )}

        {/* Routing (countries, priority) only means something for a provider
            buyers can be sent to; an inbound-only one keeps just the mode. */}
        <div className={`grid ${inbound ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-3'} gap-3 pt-2 border-t border-[var(--color-border)]`}>
          <Field
            label="Mode"
            hint={
              inbound
                ? 'live = the events describe real sales; test = a sandbox of your billing system. Revenue views read it.'
                : "live = real charges; test = sandbox, no real money. Stay in test until you're ready. Auto-detected from the key prefix."
            }
          >
            <select name="mode" defaultValue={existing?.mode ?? 'test'} className={inputCls}>
              <option value="test">Test</option>
              <option value="live">Live</option>
            </select>
          </Field>
          {!inbound && (
            <>
              <BillingModeAutodetect names={credentialFields.map((f) => f.key)} />
              <Field label="Countries" hint="Empty = global">
                <input type="text" name="countries" defaultValue={existing?.countries.join(', ') ?? ''}
                  placeholder="US, CA" className={`${inputCls} font-mono`} />
              </Field>
              <Field label="Priority" hint="Lower = first">
                <input type="number" name="priority" min={0} max={1000} step={1}
                  defaultValue={existing?.priority ?? 100} className={`${inputCls} font-mono`} />
              </Field>
            </>
          )}
        </div>

        <SubmitButton pendingLabel="Saving…">{existing ? 'Save changes' : 'Save credentials'}</SubmitButton>
      </ActionForm>
    </Modal>
  );
}
