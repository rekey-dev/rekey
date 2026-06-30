'use client';

import * as React from 'react';
import { SubmitButton } from '@/components/SubmitButton';

type Provider = 'resend' | 'smtp';

const inputCls =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]/30 focus:border-[var(--color-primary)]';

/**
 * BYO email-transport credential form. Client component so the provider
 * picker can reveal Resend vs SMTP fields without a round-trip. The actual
 * write is a server action passed in as `action`.
 */
export function EmailCredentialsForm({
  action,
  defaults,
  hasCustomCredentials,
  currentProvider,
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaults: { fromAddress: string; fromName: string; replyTo: string };
  hasCustomCredentials: boolean;
  currentProvider: Provider | null;
}): React.JSX.Element {
  const [provider, setProvider] = React.useState<Provider>(currentProvider ?? 'resend');

  return (
    <form action={action} className="space-y-4">
      <label className="block space-y-1.5 max-w-xs">
        <span className="text-sm font-medium">Provider</span>
        <select
          name="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          className={inputCls}
        >
          <option value="resend">Resend (API key)</option>
          <option value="smtp">SMTP (SES, Postmark, SendGrid, Mailgun, custom…)</option>
        </select>
      </label>

      {provider === 'resend' ? (
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Resend API key</span>
          <input
            type="password"
            name="apiKey"
            autoComplete="off"
            placeholder="re_xxxxxxxxxxxx"
            className={`${inputCls} font-mono`}
          />
          <span className="block text-xs text-[var(--color-muted-fg)]">
            Get one at{' '}
            <a href="https://resend.com/api-keys" target="_blank" rel="noreferrer" className="underline">
              resend.com/api-keys
            </a>
            . The from-address must be on a domain verified there.
          </span>
        </label>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">SMTP host</span>
              <input type="text" name="host" placeholder="smtp.postmarkapp.com" className={`${inputCls} font-mono`} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Port</span>
              <input type="number" name="port" min={1} max={65535} defaultValue={465} placeholder="465" className={`${inputCls} font-mono`} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Username</span>
              <input type="text" name="user" autoComplete="off" placeholder="apikey / SMTP username" className={`${inputCls} font-mono`} />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Password</span>
              <input type="password" name="pass" autoComplete="off" placeholder="SMTP password / token" className={`${inputCls} font-mono`} />
            </label>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" name="secure" defaultChecked className="h-4 w-4 rounded border-[var(--color-border)]" />
            <span className="text-xs">
              Implicit TLS (port 465). Uncheck for STARTTLS (port 587).
            </span>
          </label>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">From address</span>
          <input type="email" name="fromAddress" required defaultValue={defaults.fromAddress} placeholder="hello@yourdomain.com" className={inputCls} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">From name (optional)</span>
          <input type="text" name="fromName" defaultValue={defaults.fromName} placeholder="Acme Inc" className={inputCls} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Reply-To (optional)</span>
          <input type="email" name="replyTo" defaultValue={defaults.replyTo} placeholder="support@yourdomain.com" className={inputCls} />
        </label>
      </div>

      <SubmitButton pendingLabel="Saving credentials…">
        {hasCustomCredentials ? 'Update credentials' : 'Save credentials'}
      </SubmitButton>
    </form>
  );
}
