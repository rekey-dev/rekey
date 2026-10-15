import { RekeyError } from '../../lib/error.js';
import type { OperatorToolContext } from './operator-tools.js';

/** The refusal for anything that needs the admin tier, whether a whole tool or one use of a capped tool. */
export function adminTierRequired(what: string): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'OPERATOR_MCP_ADMIN_REQUIRED',
    message: `${what} requires admin access (the "mcp:operator:admin" scope), which this token does not carry.`,
    fix:
      'Connect this client through the operator MCP OAuth flow and approve admin access on the consent page. ' +
      'A personal access token never carries admin access, so use OAuth or the panel.',
  });
}

/**
 * Security: a write-tier token (an OAuth grant without the admin scope, or any
 * PAT) must not be able to hand out more authority than write tier is. Capped
 * tools call this before any use that grants or removes OWNER or ADMIN power.
 *
 * @example
 * if (role !== 'MEMBER') assertAdminTierFor(ctx, 'Inviting an OWNER or ADMIN');
 */
export function assertAdminTierFor(ctx: Pick<OperatorToolContext, 'canAdmin'>, what: string): void {
  if (!ctx.canAdmin) throw adminTierRequired(what);
}
