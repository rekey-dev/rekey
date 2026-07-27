/**
 * Account → Passkeys: operator-side WebAuthn credential management.
 *
 * Mirrors /account/security but for passkeys. Registration runs in the
 * browser via a client component (WebAuthn ceremonies require
 * `navigator.credentials.*`); list + delete stay server-rendered.
 */

import * as React from 'react';
import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api, PanelApiError } from '@/lib/api';
import { ConfirmButton } from '@/components/ConfirmButton';
import { FlashBanner } from '@/components/FlashBanner';
import { Banner } from '@/components/Banner';
import { PasskeyRegisterButton } from '@/components/PasskeyRegisterButton';
import { PageHeader } from '@/components/PageHeader';
import { Card, SectionHeader } from '@/components/Card';
import { Table, THead, TBody, TR, TH, TD } from '@/components/Table';
import { EmptyState } from '@/components/EmptyState';
import { formatDate } from '@/lib/date';
import { consumeFlash, setFlash } from '@/lib/flash';

interface PasskeyRow {
  id: string;
  credentialId: string;
  deviceName: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

type StartResult =
  | { ok: true; options: Record<string, unknown>; expectedChallenge: string }
  | { ok: false; code: string; message: string };

async function startRegistration(): Promise<StartResult> {
  'use server';
  try {
    const data = await api<{ options: Record<string, unknown>; expectedChallenge: string }>({
      method: 'POST',
      path: '/api/v1/tenant/auth/passkeys/register/start',
    });
    return { ok: true, ...data };
  } catch (err) {
    // Return (don't throw) known API errors so the client can render a clean
    // message — a thrown server-action error is sanitized in prod to the scary
    // "An error occurred in the Server Components render" digest. A genuine 401
    // re-throws here (api() already triggered the login redirect).
    if (err instanceof PanelApiError) {
      return { ok: false, code: err.code, message: ERRORS[err.code] ?? err.message };
    }
    throw err;
  }
}

async function completeRegistration(formData: FormData): Promise<void> {
  'use server';
  const responseRaw = String(formData.get('response') ?? '');
  const expectedChallenge = String(formData.get('expectedChallenge') ?? '');
  const deviceName = String(formData.get('deviceName') ?? '').trim();
  let response: unknown;
  try {
    response = JSON.parse(responseRaw);
  } catch {
    redirect('/account/passkeys?error=invalid_response');
  }
  try {
    await api({
      method: 'POST',
      path: '/api/v1/tenant/auth/passkeys/register/complete',
      body: {
        response,
        expectedChallenge,
        ...(deviceName ? { deviceName } : {}),
      },
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/passkeys?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  await setFlash('Passkey registered.');
  revalidatePath('/account/passkeys');
  redirect('/account/passkeys');
}

async function deletePasskey(id: string): Promise<void> {
  'use server';
  try {
    await api({
      method: 'DELETE',
      path: `/api/v1/tenant/auth/passkeys/${encodeURIComponent(id)}`,
    });
  } catch (err) {
    if (err instanceof PanelApiError) {
      redirect(`/account/passkeys?error=${encodeURIComponent(err.code)}`);
    }
    throw err;
  }
  await setFlash('Passkey removed.');
  revalidatePath('/account/passkeys');
  redirect('/account/passkeys');
}

const ERRORS: Record<string, string> = {
  WEBAUTHN_NOT_CONFIGURED:
    'Passkeys are not configured on this Rekey deployment. Ask your administrator to set PANEL_WEBAUTHN_RP_ID and PANEL_WEBAUTHN_RP_ORIGINS.',
  PASSKEY_REGISTRATION_FAILED:
    'The authenticator did not return a valid registration. Try again with a different device.',
  PASSKEY_ALREADY_REGISTERED:
    'That authenticator is already registered on this account.',
  PASSKEY_NOT_FOUND: 'That passkey is no longer registered.',
  invalid_response: 'Browser returned an invalid registration response. Retry.',
};

export default async function PasskeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const error = typeof sp.error === 'string' ? sp.error : undefined;
  const flash = await consumeFlash();

  const { passkeys } = await api<{ passkeys: PasskeyRow[] }>({
    method: 'GET',
    path: '/api/v1/tenant/auth/passkeys',
  });

  return (
    <section className="mx-auto max-w-7xl space-y-5 px-6 py-8 lg:px-8">
      <PageHeader
        eyebrow={
          <Link
            href="/account/security"
            className="inline-flex items-center gap-1 rounded text-xs text-[var(--color-muted-fg)] transition-colors hover:text-[var(--color-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--color-primary)_50%,transparent)]"
          >
            ← Security
          </Link>
        }
        title="Passkeys"
        description="Sign into the panel without a password using your device's biometric (Touch ID, Windows Hello) or a hardware key. Stronger than TOTP and phishing-resistant."
      />

      {flash && <FlashBanner flash={flash} />}
      {error && (
        <Banner tone="error">
          {ERRORS[error] ?? 'Something went wrong. Please try again.'}
        </Banner>
      )}

      <Card className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Register a new passkey</h3>
          <p className="text-xs text-[var(--color-muted-fg)]">
            Your browser will prompt you to confirm with the authenticator. The label is
            optional — handy when you have more than one device.
          </p>
        </div>
        <PasskeyRegisterButton start={startRegistration} complete={completeRegistration} />
      </Card>

      <section className="space-y-3">
        <SectionHeader title="Registered passkeys" count={`(${passkeys.length})`} />
        {passkeys.length === 0 ? (
          <EmptyState
            variant="inline"
            title="No passkeys yet"
            description="Add one above and you can sign in with it next time."
          />
        ) : (
          <Table minWidth="min-w-[36rem]">
            <THead>
              <TR>
                <TH>Device</TH>
                <TH>Registered</TH>
                <TH>Last used</TH>
                <TH align="right">
                  <span className="sr-only">Actions</span>
                </TH>
              </TR>
            </THead>
            <TBody>
              {passkeys.map((p) => (
                <TR key={p.id} hover>
                  <TD className="font-medium">
                    {p.deviceName ?? (
                      <span className="font-normal text-[var(--color-muted-fg)]">Unnamed device</span>
                    )}
                  </TD>
                  <TD muted className="text-xs">{formatDate(p.createdAt)}</TD>
                  <TD muted className="text-xs">
                    {p.lastUsedAt ? formatDate(p.lastUsedAt) : 'never'}
                  </TD>
                  <TD align="right">
                    <form action={deletePasskey.bind(null, p.id)} className="inline">
                      <ConfirmButton confirm={`Remove the passkey "${p.deviceName ?? 'Unnamed device'}"? You will need to register a new one to use passkey sign-in from this device.`}>
                        Remove
                      </ConfirmButton>
                    </form>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </section>
    </section>
  );
}
