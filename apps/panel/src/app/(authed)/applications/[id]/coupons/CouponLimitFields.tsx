'use client';

/**
 * When a coupon ends and how often it may be redeemed, shared by the create
 * and edit coupon forms. Every field is held in state, so a refused save
 * keeps what was typed.
 */

import * as React from 'react';
import { Field, fieldInputCls } from '@/components/Field';

export interface CouponLimitsInitial {
  /** ISO 8601, or null for a coupon that never ends. */
  endsAt: string | null;
  maxRedemptions: number | null;
  maxRedemptionsPerUser: number | null;
}

const NONE: CouponLimitsInitial = { endsAt: null, maxRedemptions: null, maxRedemptionsPerUser: null };

/** An instant as a `datetime-local` input writes it, in the browser's own time zone. */
function localText(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

function instantOf(local: string): string {
  const at = new Date(local);
  return local === '' || Number.isNaN(at.getTime()) ? '' : at.toISOString();
}

export function CouponLimitFields({
  initial = NONE,
  held,
}: {
  initial?: CouponLimitsInitial;
  /** Redemptions already settled, for the hint under the cap of a coupon being edited. */
  held?: number;
}): React.JSX.Element {
  // The instant is what is submitted. It is worked out here, in the browser,
  // because the server does not know which time zone the operator typed in.
  const [endsAt, setEndsAt] = React.useState(initial.endsAt ?? '');
  const [local, setLocal] = React.useState('');
  const [maxRedemptions, setMaxRedemptions] = React.useState(initial.maxRedemptions === null ? '' : String(initial.maxRedemptions));
  const [maxPerUser, setMaxPerUser] = React.useState(
    initial.maxRedemptionsPerUser === null ? '' : String(initial.maxRedemptionsPerUser),
  );
  // After mount, so the server render and the browser agree before the local time is shown.
  React.useEffect(() => {
    setLocal(initial.endsAt === null ? '' : localText(initial.endsAt));
  }, [initial.endsAt]);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label="Expires at" hint="In your time zone. Empty means it never expires.">
        <input type="hidden" name="endsAt" value={endsAt} />
        <input
          type="datetime-local"
          value={local}
          onChange={(e) => {
            setLocal(e.currentTarget.value);
            setEndsAt(instantOf(e.currentTarget.value));
          }}
          className={fieldInputCls}
        />
      </Field>
      <Field
        label="Max redemptions"
        hint={
          held === undefined
            ? 'Counted across every currency. Empty means no limit.'
            : `Redeemed ${held} so far. Empty means no limit. It cannot go below the redemptions already held, open checkouts included.`
        }
      >
        <input
          type="number"
          name="maxRedemptions"
          min={1}
          step={1}
          value={maxRedemptions}
          onChange={(e) => setMaxRedemptions(e.currentTarget.value)}
          className={`${fieldInputCls} font-mono`}
        />
      </Field>
      <Field label="Max per end-user" hint="Empty means no limit.">
        <input
          type="number"
          name="maxRedemptionsPerUser"
          min={1}
          step={1}
          value={maxPerUser}
          onChange={(e) => setMaxPerUser(e.currentTarget.value)}
          className={`${fieldInputCls} font-mono`}
        />
      </Field>
    </div>
  );
}
