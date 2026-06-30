'use client';

import * as React from 'react';
import { track, type AnalyticsEventName } from '@/lib/analytics';

/**
 * Fire-on-mount analytics event. Drop into a server-rendered page to record a
 * named view (e.g. login_page_view) without turning the whole page client.
 * Renders nothing.
 */
export function TrackView({
  event,
  params,
}: {
  event: AnalyticsEventName;
  params?: Record<string, unknown>;
}): null {
  React.useEffect(() => {
    track(event, params);
    // Fire once per mount; `params` is treated as static for a given view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);
  return null;
}
