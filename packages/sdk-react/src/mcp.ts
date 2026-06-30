/**
 * MCP connection helper.
 *
 * When an Application has MCP enabled (Panel → Application → MCP), end-users
 * connect an MCP client (Claude Code, Claude Desktop, Cursor) to their account.
 * This builds the connection URL + the `claude mcp add` command so your app can
 * render a "Connect to Claude" affordance. Pure string-building — no network,
 * no auth (the MCP client runs the OAuth flow itself).
 */

export interface McpConnectionInfo {
  /** The MCP server URL the client connects to. */
  url: string;
  /** Ready-to-run `claude mcp add` command. */
  claudeAddCommand: string;
}

export function mcpConnectionInfo(args: { apiUrl: string; appSlug: string }): McpConnectionInfo {
  const base = args.apiUrl.replace(/\/$/, '');
  const url = `${base}/api/v1/mcp/${args.appSlug}`;
  return {
    url,
    claudeAddCommand: `claude mcp add --transport http ${args.appSlug} ${url}`,
  };
}
