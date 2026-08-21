import * as React from 'react';
import type { WorkspaceLimitsDto } from '@/lib/api';

/**
 * Workspace resource ceilings and the usage counted against them.
 *
 * Built for a deployment that has set NO limits, which is the default and the
 * state of every self-host that never touches the feature. That case is not an
 * error and not an empty state — it is the normal, fully-working configuration,
 * so it renders as an affirmative "no limit" rather than a blank, a zero, or a
 * meter pinned at 0%. Reading an absent ceiling as 0 is the specific bug this
 * component exists to not have: it would tell an unlimited workspace it was
 * full.
 *
 * Three shapes have to look right:
 *
 *   - nothing configured    → every row reads "no limit"
 *   - partly configured     → a deployment may cap production apps and not
 *                             end-users; the rows are independent
 *   - a very large ceiling  → 1,000,000 must not overflow its row, and a meter
 *                             at 0.0003% must not render as a stray pixel that
 *                             reads like a rendering fault
 *
 * The numbers are read-only here on purpose. Only a deployment super-admin can
 * write `Tenant.limits`; a ceiling the workspace can raise itself is not a
 * ceiling. The footnote says so rather than leaving an operator hunting for an
 * edit control that does not exist.
 *
 * Rendered only for OWNER/ADMIN. The endpoint behind it refuses MEMBERs because
 * both usage figures are workspace-wide, and the application list is
 * grant-scoped precisely so a MEMBER is not handed a workspace-wide count. The
 * caller decides whether to fetch; this component does not handle a missing
 * payload, because "render nothing" is the page's decision, not this one's.
 */

/** One ceiling, or the absence of one. `max` null/undefined means unlimited. */
interface LimitRow {
  label: string;
  /** What the number counts, in the operator's terms — not the column name. */
  hint: string;
  used: number;
  max: number | null | undefined;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function Meter({ used, max }: { used: number; max: number }): React.JSX.Element {
  // Guard the zero-ceiling case before dividing. `maxProductionApps: 0` is a
  // legitimate configuration (a workspace deliberately allowed no production
  // apps) and it is the one value that would make this NaN.
  const pct = max <= 0 ? 100 : Math.min(100, (used / max) * 100);
  const atCeiling = used >= max;
  // A workspace one slot from its ceiling is the case worth catching before it
  // bites, so it gets its own tone rather than reading as ordinary headroom.
  const nearCeiling = !atCeiling && max > 0 && max - used <= Math.max(1, Math.floor(max * 0.1));

  const tone = atCeiling
    ? 'bg-red-500'
    : nearCeiling
      ? 'bg-amber-500'
      : 'bg-[var(--color-primary)]';

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg)]"
      role="img"
      aria-label={`${fmt(used)} of ${fmt(max)} used`}
    >
      <div
        className={`h-full rounded-full ${tone}`}
        // A non-zero usage must never round away to an invisible bar — at a
        // ceiling of 1,000,000 a single used slot is 0.0001%, which paints
        // nothing at all and reads as "zero used" when it is not.
        style={{ width: `${pct === 0 ? 0 : Math.max(pct, 1.5)}%` }}
      />
    </div>
  );
}

function Row({ label, hint, used, max }: LimitRow): React.JSX.Element {
  const unlimited = max === null || max === undefined;

  return (
    <div className="space-y-1.5 py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-[var(--color-fg)]">{label}</span>
        <span className="font-mono text-sm tabular-nums text-[var(--color-fg)]">
          {unlimited ? (
            <>
              {fmt(used)}{' '}
              <span className="text-[var(--color-muted-fg)]">· no limit</span>
            </>
          ) : (
            <>
              {fmt(used)}{' '}
              <span className="text-[var(--color-muted-fg)]">of {fmt(max)}</span>
            </>
          )}
        </span>
      </div>
      {!unlimited && <Meter used={used} max={max} />}
      <p className="text-xs text-[var(--color-muted-fg)]">{hint}</p>
    </div>
  );
}

export function WorkspaceLimits({
  data,
}: {
  data: WorkspaceLimitsDto;
}): React.JSX.Element {
  const { limits, usage } = data;
  const anyLimitSet =
    (limits.maxProductionApps !== null && limits.maxProductionApps !== undefined) ||
    (limits.maxActiveEndUsers !== null && limits.maxActiveEndUsers !== undefined);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">Usage and limits</h2>
        <p className="mt-1 text-sm text-[var(--color-muted-fg)]">
          {anyLimitSet
            ? 'What this workspace is using, against the ceilings set for it.'
            : 'What this workspace is using. This deployment sets no ceilings, so nothing here can run out.'}
        </p>
      </div>

      <div className="divide-y divide-[var(--color-border)]">
        <Row
          label="Production applications"
          hint="Applications in the production environment that are running. Disabled ones are not counted, and development and staging applications are never counted."
          used={usage.productionApps}
          max={limits.maxProductionApps}
        />
        <Row
          label="End users"
          hint="Across every application in this workspace. Erased users are not counted."
          used={usage.activeEndUsers}
          max={limits.maxActiveEndUsers}
        />
      </div>

      {anyLimitSet && (
        <p className="text-xs text-[var(--color-muted-fg)]">
          Limits are set by whoever runs this deployment and cannot be changed from the panel. On a
          self-hosted Rekey a deployment administrator sets them; on Rekey Cloud, get in touch to
          raise one. Reaching a ceiling never takes anything offline — existing applications keep
          serving and existing users keep signing in.
        </p>
      )}
    </div>
  );
}
