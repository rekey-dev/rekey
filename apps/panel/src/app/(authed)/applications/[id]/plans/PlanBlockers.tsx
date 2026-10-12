import * as React from 'react';
import Link from '@/components/Link';
import type { PlanBlocker } from '@/lib/api';
import { panelRepair, type PanelRepair } from '@/lib/plan-blockers';

/**
 * Why a plan cannot be bought: each blocker's own sentence, the provider it
 * belongs to, and what to do about it in the panel. The API's own repair,
 * which names routes, stays one click away. Shown in the plan's edit dialog,
 * so the reason sits beside the controls that fix it.
 *
 * `register` renders the plan's register control with the label it is given,
 * for the blockers registering repairs.
 */
export function PlanBlockers({
  blockers,
  applicationId,
  providerLabel,
  register,
}: {
  blockers: readonly PlanBlocker[];
  applicationId: string;
  providerLabel: (name: string) => string;
  register?: (label: NonNullable<PanelRepair['register']>) => React.ReactNode;
}): React.JSX.Element | null {
  if (blockers.length === 0) return null;
  return (
    <section
      aria-label="Why this plan cannot be bought"
      className="space-y-2 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400"
    >
      <h3 className="font-medium">
        {blockers.length === 1 ? 'This plan cannot be bought' : `This plan cannot be bought, for ${blockers.length} reasons`}
      </h3>
      <ul className="space-y-2">
        {blockers.map((blocker) => {
          const repair = panelRepair(blocker, applicationId);
          return (
            <li key={`${blocker.provider ?? 'none'}-${blocker.code}`} className="text-xs">
              <p>
                {blocker.provider !== null && <strong className="font-medium">{providerLabel(blocker.provider)}: </strong>}
                {blocker.message}
              </p>
              {repair === null ? (
                <p className="mt-0.5 opacity-90">
                  <span className="font-medium">To repair: </span>
                  {blocker.fix}
                </p>
              ) : (
                <>
                  <p className="mt-0.5 opacity-90">
                    <span className="font-medium">To repair: </span>
                    {repair.action}
                  </p>
                  {(repair.link !== null || (repair.register !== null && register !== undefined)) && (
                    <p className="mt-1 flex flex-wrap items-center gap-3">
                      {repair.link !== null && (
                        <Link href={repair.link.href} className="font-medium underline">
                          Open {repair.link.label}
                        </Link>
                      )}
                      {repair.register !== null && register?.(repair.register)}
                    </p>
                  )}
                  <details className="mt-1 opacity-90">
                    <summary className="cursor-pointer">How to do this over the API</summary>
                    <p className="mt-0.5">{blocker.fix}</p>
                  </details>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
