/**
 * The panel's only `<Link>`. Same props as `next/link`, one different default:
 * **no prefetch**, neither in the viewport nor on hover.
 *
 * ## Why
 *
 * Next's default (`prefetch` unset) fires a prefetch for every link that
 * scrolls into view, again on hover, and again whenever its cache entry is
 * older than `staleTimes.dynamic` or a `router.refresh()` emptied the cache.
 * Every one of those is a request to this server, and a prefetch whose target
 * has a `loading.tsx` renders every layout between the divergence point and
 * that boundary, with the layout's API calls. Measured on a production build
 * (`next build` + `next start`, against a counting mock of the API):
 *
 *   - first load of an end-user page: 21 prefetch requests (sidebar 9, AppNav
 *     6, the end-user tab strip 5, the overview's own links), before the
 *     operator clicked anything;
 *   - first load of `/applications` with three applications: 13 prefetches
 *     and 5 extra API calls, one `GET /applications/:id` per card plus two for
 *     the onboarding links, because `applications/[id]/` has a layout and a
 *     loading boundary.
 *
 * At the time the API's rate limit was keyed on the panel container's address,
 * so every operator shared one budget and a single person browsing a support
 * ticket got 429s within a few pages. The limiter now keys on the operator, so
 * the 429s are gone, but the request volume itself is still worth not sending.
 *
 * ## What replaces it
 *
 * A click fetches exactly one render. Feedback comes from the `loading.tsx`
 * boundaries under each tab strip, and, for the navigation surfaces, from
 * `<LinkPending>` (in `LinkPending.tsx`), which dims the clicked label from
 * the moment of the click. A page visited in the last `staleTimes.dynamic` seconds is
 * still reused from the router cache, so going back to a tab costs nothing.
 *
 * `prefetch` is still a prop: a caller that has measured a reason to prefetch
 * one link can pass `prefetch` explicitly. `test/request-volume.test.ts` fails
 * when anything under `src/` pulls in `next/link` directly (the one exception
 * is `LinkPending.tsx`, for `useLinkStatus`, which is not a link).
 */

import * as React from 'react';
import NextLink from 'next/link';

type Props = React.ComponentProps<typeof NextLink>;

export default function Link({ prefetch = false, ...props }: Props): React.JSX.Element {
  return <NextLink prefetch={prefetch} {...props} />;
}
