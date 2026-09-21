/**
 * End-user Data & privacy, the DSAR export and the GDPR erasure.
 *
 * These are on their own tab because they are not support actions. Everything
 * else in this console is reversible or additive; this tab is where the account
 * ends. Sitting three sections below a credit adjustment in one long scroll,
 * as it did, put the most destructive control in the product next to the most
 * routine one.
 *
 * ## Role gating
 *
 * Erase is rendered for the workspace OWNER only, matching the API floor.
 *
 * Both `DELETE …/end-users/:euid` forms are OWNER-only there. They did not use
 * to be: erasure was OWNER/ADMIN, and the plain cascade delete was the
 * per-application `write` grant alone, which a MEMBER holding `APP_ADMIN`
 * satisfies. So the path that retains the accounting record was gated harder
 * than the path that destroys it. The panel never offered the plain delete, and
 * still does not, a data-subject request wants the erasure, and an operator
 * who genuinely wants everything gone can say so through the API.
 */

import * as React from 'react';
import { errorMessage } from '@/lib/error-message';
import { getMe } from '@/lib/api';
import { ActionForm } from '@/components/ActionForm';
import { Card } from '@/components/Card';
import { Banner } from '@/components/Banner';
import { TypedConfirmButton } from '@/components/TypedConfirmButton';
import { eraseUser } from '../actions';
import { getEndUserDetail } from '../shared';

const ERASE_ERR: Record<string, string> = {
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  TENANT_ROLE_INSUFFICIENT: 'Only the workspace owner can erase an end-user.',
  APP_ACCESS_DENIED: 'Your grant on this Application does not allow this.',
};

export default async function EndUserDataPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; euid: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const { id, euid } = await params;
  const sp = await searchParams;
  const eraseError = typeof sp.eraseError === 'string' ? sp.eraseError : undefined;
  const erased = sp.erased === '1';

  const [detail, me] = await Promise.all([getEndUserDetail(id, euid), getMe()]);
  const isErased = detail.endUser.erasedAt !== null;
  const isOwner = me.activeRole === 'OWNER';

  return (
    <div className="space-y-4">
      {erased && (
        <Banner tone="error">
          End-user erased. PII and credentials were deleted; financial records are retained
          anonymized.
        </Banner>
      )}
      {eraseError && <Banner tone="error">{errorMessage(ERASE_ERR, eraseError)}</Banner>}

      <Card className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">Export data (JSON)</h3>
            <p className="max-w-xl text-xs text-[var(--color-muted-fg)]">
              OWNER / ADMIN only. Downloads everything Rekey stores about this end-user (profile,
              identities, session metadata, billing, credits, usage, security events) as a single
              JSON document. Use it to answer GDPR / CCPA data-subject access requests (DSARs).
              Credential material (password hashes, token hashes, MFA secrets) is never included.
            </p>
          </div>
          <a
            href={`/applications/${id}/end-users/${euid}/export`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
            title="Download this end-user's stored data as JSON (GDPR/DSAR)"
          >
            Export data (JSON)
          </a>
        </div>
      </Card>

      <Card className="space-y-3 border-red-300 dark:border-red-800">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">Erase (GDPR)</h3>
            <p className="max-w-xl text-xs text-[var(--color-muted-fg)]">
              Workspace OWNER only. Permanently erases this end-user&apos;s personal data and
              credentials (email, profile, OAuth links, sessions, MFA, passkeys) and tombstones the
              account so they can never sign in again. Distinct from a plain delete: financial
              records (payments, subscriptions, licenses, credit ledger, usage) are{' '}
              <strong>retained but anonymized</strong> to meet accounting / legal-retention
              obligations. Any live provider subscription is cancelled first, best-effort. This
              cannot be undone.
            </p>
          </div>
          {isErased ? (
            <span
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-muted-fg)] opacity-60"
              title="This end-user has already been erased"
            >
              Already erased
            </span>
          ) : isOwner ? (
            <ActionForm action={eraseUser.bind(null, id, euid)} className="inline">
              <TypedConfirmButton
                expected={detail.endUser.email}
                title="Erase this end-user (GDPR)?"
                description={
                  "This permanently deletes the user's PII and credentials and tombstones the account, so " +
                  'they can never sign in again. Financial records are retained but anonymized. This cannot be undone.'
                }
                triggerLabel="Erase (GDPR)"
                confirmLabel="Erase permanently"
                triggerClassName="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400 dark:hover:bg-red-950"
              />
            </ActionForm>
          ) : (
            <span className="max-w-[14rem] text-right text-xs text-[var(--color-muted-fg)]">
              Restricted to the workspace owner. Your role is {me.activeRole.toLowerCase()}.
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
