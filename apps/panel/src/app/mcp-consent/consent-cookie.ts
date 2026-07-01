/**
 * Shared constant for the operator MCP consent flow.
 *
 * Kept out of `route.ts` because Next route modules may only export route
 * handlers (GET/POST/…) + a fixed set of config keys — exporting an arbitrary
 * const there fails `next build` with "does not match the required types of a
 * Next.js Route".
 */
export const CONSENT_COOKIE = 'mcp_consent_pending';
