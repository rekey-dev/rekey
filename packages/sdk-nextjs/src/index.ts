/**
 * @rekey.dev/nextjs — Next.js helpers for Rekey.
 *
 * Entrypoints:
 *
 *   `@rekey.dev/nextjs/middleware`  — rekeyMiddleware() for middleware.ts
 *   `@rekey.dev/nextjs/server`      — auth() / signIn() / signOut() / createSession() server-side (secret key)
 *   `@rekey.dev/nextjs/client`      — rekeyBrowser() for client-component login/register (publishable key)
 *
 * Server + middleware helpers are re-exported here for convenience. The client
 * helper is NOT re-exported — import it from `@rekey.dev/nextjs/client` so the
 * secret-key server module never gets pulled into a browser bundle. Direct
 * subpath imports also keep the edge bundle minimal.
 */

export { rekeyMiddleware } from './middleware.js';
export { auth, signIn, signUp, mfaVerify, signOut, createSession } from './server.js';
export type { Session, SignInOutcome } from './server.js';
export type { MiddlewareConfig } from './middleware.js';
export {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  ACCESS_COOKIE_OPTS,
  REFRESH_COOKIE_OPTS,
} from './cookies.js';

export interface McpConnectionInfo {
  url: string;
  claudeAddCommand: string;
}

/**
 * Build the MCP connection URL + `claude mcp add` command for an MCP-enabled
 * Application (Panel → Application → MCP). Render a "Connect to Claude" button
 * with this. Pure string-building — the MCP client runs the OAuth flow itself.
 */
export function mcpConnectionInfo(args: { apiUrl: string; appSlug: string }): McpConnectionInfo {
  const base = args.apiUrl.replace(/\/$/, '');
  const url = `${base}/api/v1/mcp/${args.appSlug}`;
  return { url, claudeAddCommand: `claude mcp add --transport http ${args.appSlug} ${url}` };
}
