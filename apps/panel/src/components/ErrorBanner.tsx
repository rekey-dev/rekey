/**
 * Standard error banner — thin wrapper over the <Banner> primitive.
 *
 * Maps a known error code to a friendly message via the page's local
 * `messages` map; falls back to a generic "Something went wrong" line
 * with the request id surfaced so the operator can share it with
 * support. Without this, unknown codes used to leak as raw
 * `SCREAMING_SNAKE_CASE` (UX-AUDIT HIGH #11).
 */

import * as React from 'react';
import { Banner } from './Banner';

interface Props {
  code: string;
  /** Per-page friendly messages, keyed by error code. */
  messages?: Record<string, string>;
  /** Surface the panel-side request id from `PanelApiError.requestId`. */
  requestId?: string | null;
}

export function ErrorBanner({ code, messages, requestId }: Props): React.JSX.Element {
  const known = messages?.[code];
  return (
    <Banner tone="error" className="space-y-1">
      <span className="block">
        {known ??
          'Something went wrong on our side. Please retry; if the problem persists, share the request id below with support.'}
      </span>
      {requestId && (
        <span className="block text-xs font-mono opacity-80">request id: {requestId}</span>
      )}
    </Banner>
  );
}
