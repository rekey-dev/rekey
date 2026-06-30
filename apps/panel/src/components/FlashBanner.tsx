/**
 * Renders a flash payload consumed by the parent page.
 *
 * Pure presentation — the consume happens in the page server component so
 * we don't render this when the cookie is empty.
 */

import * as React from 'react';
import type { FlashPayload } from '@/lib/flash';

const TONES: Record<FlashPayload['tone'], string> = {
  success:
    'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300',
  info: 'border-sky-300 dark:border-sky-700 bg-sky-50 dark:bg-sky-950 text-sky-700 dark:text-sky-300',
  warning:
    'border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-950 text-amber-800 dark:text-amber-300',
  error: 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300',
};

export function FlashBanner({ flash }: { flash: FlashPayload }): React.JSX.Element {
  return (
    <p
      role={flash.tone === 'error' ? 'alert' : undefined}
      aria-live={flash.tone === 'error' ? undefined : 'polite'}
      className={`rounded border px-3 py-2 text-sm ${TONES[flash.tone]}`}
    >
      {flash.message}
    </p>
  );
}
