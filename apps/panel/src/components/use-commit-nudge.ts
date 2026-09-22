'use client';

import * as React from 'react';
import { nudgeUntilCommitted } from '@/lib/commit-nudge';
import { committedRender } from '@/lib/render-stamp';

/**
 * `mark()` records which server render is on screen now; `start()` then nudges
 * this component until a different one has been committed. See
 * `lib/commit-nudge.ts` for why a server render needs nudging at all.
 *
 * The nudge is a state update on the calling component, so it re-renders that
 * component and nothing it was handed as children. Stops on unmount.
 */
export function useCommitNudge(): { mark: () => void; start: () => void } {
  const [, setTick] = React.useState(0);
  const renderAtMark = React.useRef<string | null>(null);
  const cancel = React.useRef<() => void>(() => undefined);

  React.useEffect(() => () => cancel.current(), []);

  const mark = React.useCallback(() => {
    renderAtMark.current = committedRender();
  }, []);

  const start = React.useCallback(() => {
    cancel.current();
    const before = renderAtMark.current;
    cancel.current = nudgeUntilCommitted({
      nudge: () => setTick((n) => n + 1),
      committed: () => {
        const now = committedRender();
        return now !== null && now !== before;
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
    });
  }, []);

  return React.useMemo(() => ({ mark, start }), [mark, start]);
}
