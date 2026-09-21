/**
 * Tells a server render apart when it is the destination of a Server Action's
 * `redirect()`.
 *
 * When an action redirects to a path in this app, Next 15.5 renders the
 * destination inside the action's own response: `createRedirectRenderResult`
 * in `next/dist/server/app-render/action-handler.js` sets `x-action-redirect`
 * on the action response and THEN builds the internal GET from the request
 * headers merged with the response headers (`getForwardedHeaders`). So that
 * internal render, and only that render, arrives carrying `x-action-redirect`.
 * A browser navigation, a prefetch and a `router.refresh()` never do.
 *
 * `test/action-landing.test.ts` checks that ordering against the installed
 * runtime, so a Next upgrade that changes it fails the suite rather than
 * silently turning the post-write refresh off.
 */

export const ACTION_REDIRECT_HEADER = 'x-action-redirect';

export function landedFromServerAction(headers: Pick<Headers, 'has'>): boolean {
  return headers.has(ACTION_REDIRECT_HEADER);
}
