/**
 * The per-workspace switch for the operator MCP server.
 *
 * Two kill switches exist above and below this one. OPERATOR_MCP_ENABLED is
 * deployment-wide: off, and the server does not mount for anybody.
 * `authConfig.mcpEnabled` is per APPLICATION and governs the end-user MCP
 * server, a different thing. Neither lets one workspace's owner say "no agent
 * acts as any of my operators", which is the decision this column makes.
 *
 * Checked at AUTH time on both bearer paths (folded into the membership read
 * there, so it costs no extra query per call) and at CONSENT. Off refuses
 * every access token presented for the workspace, PAT or OAuth, and grants
 * no new consent. It does NOT touch the OAuth refresh chain: an agent that
 * holds a refresh token keeps rotating it while the workspace is off, and
 * every access token that mints is refused at auth like any other. That is
 * the point, nothing is revoked, so on again restores every agent without a
 * re-consent, which is what an owner flipping this for an incident wants.
 *
 * The one deliberate exception to bearer-auth's "generic 401 on any failure":
 * a VALID credential for a switched-off workspace answers 403 with a fix,
 * because the caller is a confirmed member and the remedy is theirs to ask
 * for. Non-members still get the generic 401, so the switch state is visible
 * only to the workspace's own credentials.
 */

import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';

export function operatorMcpDisabled(): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'OPERATOR_MCP_DISABLED',
    message: 'The operator MCP server is switched off for this workspace.',
    fix: 'A workspace owner or admin can turn it back on under Workspace settings (PATCH /api/v1/tenant/workspace { operatorMcpEnabled: true }).',
  });
}

/**
 * Throw unless the workspace admits operator MCP. One indexed read; used at
 * consent, where no membership row is in hand. The bearer paths read the
 * flag through the membership's tenant instead and throw operatorMcpDisabled.
 */
export async function assertOperatorMcpEnabled(tenantId: string): Promise<void> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { operatorMcpEnabled: true },
  });
  if (t === null || t.operatorMcpEnabled === false) throw operatorMcpDisabled();
}
