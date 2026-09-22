/**
 * Who may put an elevated scope on a key.
 *
 * Minting a key is a developer act (`developer:write`), but a key carrying
 * `credits:grant` can mint credits, which the panel only lets a caller with
 * billing-write access do. Without this check a member who is refused the
 * panel's credit grant could mint a key with the scope and grant through it.
 * So a key with an elevated scope needs the authority of the thing the scope
 * does: for `credits:grant`, the panel credit grant's own gate (billing-write
 * access to the Application AND the `billing:write` operator scope).
 *
 * Every operator path that sets key scopes calls this: the tenant route, the
 * operator-PAT route and the MCP `mint_api_key` tool. The super-admin route
 * is the deployment key and needs no second gate. The PAT route matters for
 * the token-narrowing check at the end: PATs are OWNER/ADMIN only.
 */

import { isElevatedApiKeyScope } from '@rekey.dev/shared-types';
import { applicationAccess, scopeDenied, type AccessContext } from '../../lib/access-context.js';

export async function assertMayMintScopes(
  ctx: AccessContext,
  applicationId: string,
  scopes: readonly string[],
): Promise<void> {
  if (!scopes.some(isElevatedApiKeyScope)) return;
  // Throws APP_ACCESS_DENIED / SCOPE_INSUFFICIENT exactly as the panel grant
  // route (`/:id/end-users/:euid/credits/grant`) would for this caller.
  await applicationAccess(ctx, applicationId, 'billing-write', { scope: 'billing:write' });
  // `applicationAccess` does not read scopes for an OWNER/ADMIN: role is their
  // ceiling. But a token can narrow its holder, and an owner's `keys:mint`-only
  // PAT carries `developer:write` and nothing about billing. Minting it a key
  // that grants credits would let the token do more than it was issued for.
  if (!ctx.scopes.has('billing:write')) throw scopeDenied('billing:write');
}
