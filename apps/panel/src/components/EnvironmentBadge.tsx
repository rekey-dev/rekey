import * as React from 'react';
import { Badge, type BadgeTone } from './Badge';
import type { ApplicationRow } from '@/lib/api';

type AppEnvironment = ApplicationRow['environment'];

/**
 * An application's environment is fixed at creation and there is no endpoint
 * that changes it, so this is a label rather than a control — nothing here
 * links to an editor. Tones stay calm on purpose: the environment is what the
 * application IS, not a problem to fix, so PRODUCTION gets the brand tint
 * rather than a red alarm.
 */
const TONES: Record<AppEnvironment, BadgeTone> = {
  PRODUCTION: 'brand',
  STAGING: 'info',
  DEVELOPMENT: 'neutral',
};

const LABELS: Record<AppEnvironment, string> = {
  PRODUCTION: 'Production',
  STAGING: 'Staging',
  DEVELOPMENT: 'Development',
};

/**
 * The prefix an application's secret keys carry. Derived API-side from the
 * environment (`api-keys.service.ts`), mirrored here so panel copy can show
 * the prefix an operator will actually get instead of guessing `rp_live_`.
 * Descriptive only — nothing in the API branches on it.
 */
export function keyPrefixFor(environment: AppEnvironment): string {
  return environment === 'PRODUCTION' ? 'rp_live_' : 'rp_test_';
}

export function EnvironmentBadge({
  environment,
  className = '',
}: {
  environment: AppEnvironment;
  className?: string;
}): React.JSX.Element {
  return (
    <Badge tone={TONES[environment]} className={className}>
      {LABELS[environment]}
    </Badge>
  );
}
