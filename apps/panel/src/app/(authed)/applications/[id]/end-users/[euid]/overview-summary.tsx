import * as React from 'react';
import { Badge } from '@/components/Badge';
import { ActionForm } from '@/components/ActionForm';
import { SubmitButton } from '@/components/SubmitButton';
import { setOnboardingOutcome } from './actions';
import { formatDate, formatDateTime, formatRelative } from '@/lib/date';
import { describeSource, signInViaLabel, type EndUserInsightsDto } from './insights';

const ONBOARDING_BUTTON =
  'rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium hover:bg-[var(--color-surface-muted)] disabled:opacity-60';

/**
 * The sign-in lines of the Profile card: first and last sign-in, and
 * onboarding. "Has not signed in" is only said when insights were read.
 * `onboardingActions` carries the ids for the complete and skip buttons; leave
 * it out when the operator may not write.
 */
export function SignInSummary({
  insights,
  createdAt,
  onboardingActions,
}: {
  insights: EndUserInsightsDto | null;
  createdAt: string;
  onboardingActions?: { applicationId: string; euid: string } | undefined;
}): React.JSX.Element | null {
  if (!insights) return null;
  const { signIns, profile, sources } = insights;
  const latest = sources[0];
  const lastDetail = [
    signIns.lastSignInVia ? `via ${signInViaLabel(signIns.lastSignInVia)}` : null,
    latest ? describeSource(latest) : null,
    latest?.country ?? insights.platforms.lastCountry,
  ]
    .filter(Boolean)
    .join(', ');
  const required = profile.fields.filter((f) => f.requiredForOnboarding).length;
  const onboarding = profile.onboardingCompletedAt
    ? `Completed ${formatDate(profile.onboardingCompletedAt)}`
    : profile.onboardingSkippedAt
      ? `Skipped ${formatDate(profile.onboardingSkippedAt)}`
      : profile.fields.length === 0
      ? 'No onboarding questions defined'
      : `${required - profile.missingRequired.length} of ${required} required answered`;

  return (
    <dl className="grid grid-cols-1 gap-3 border-t border-[var(--color-border)] pt-3 text-sm sm:grid-cols-3">
      <div className="min-w-0">
        <dt className="text-xs text-[var(--color-muted-fg)]">Last sign-in</dt>
        <dd className="text-[var(--color-fg)]">
          {signIns.lastSignedInAt ? (
            <span title={formatDateTime(signIns.lastSignedInAt)}>
              {formatRelative(signIns.lastSignedInAt)}
              {lastDetail && <span className="text-xs text-[var(--color-muted-fg)]"> {lastDetail}</span>}
            </span>
          ) : (
            <span className="text-xs text-[var(--color-muted-fg)]">
              Has not signed in yet (created {formatDate(createdAt)})
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-[var(--color-muted-fg)]">First sign-in</dt>
        <dd className="text-[var(--color-fg)]">
          {signIns.firstSignedInAt ? formatDate(signIns.firstSignedInAt) : <span className="text-xs text-[var(--color-muted-fg)]">never</span>}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-[var(--color-muted-fg)]">Onboarding</dt>
        <dd className="text-[var(--color-fg)]">
          {profile.onboardingCompletedAt ? (
            <Badge tone="success" dot>
              {onboarding}
            </Badge>
          ) : profile.onboardingSkippedAt ? (
            <Badge tone="neutral" dot>
              {onboarding}
            </Badge>
          ) : (
            <span className="text-sm">{onboarding}</span>
          )}
          {onboardingActions && profile.onboardingStatus === 'pending' && (
            <div className="mt-1.5 flex flex-wrap gap-2">
              <ActionForm
                action={setOnboardingOutcome.bind(null, onboardingActions.applicationId, onboardingActions.euid, 'complete')}
              >
                <SubmitButton pendingLabel="Marking…" className={ONBOARDING_BUTTON}>
                  Mark complete
                </SubmitButton>
              </ActionForm>
              <ActionForm
                action={setOnboardingOutcome.bind(null, onboardingActions.applicationId, onboardingActions.euid, 'skip')}
              >
                <SubmitButton pendingLabel="Recording…" className={ONBOARDING_BUTTON}>
                  Record skip
                </SubmitButton>
              </ActionForm>
            </div>
          )}
        </dd>
      </div>
    </dl>
  );
}
