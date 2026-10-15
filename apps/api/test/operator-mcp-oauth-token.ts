import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

export const MCP_WRITE_SCOPE = 'mcp:operator:read mcp:operator:write';
export const MCP_ADMIN_SCOPE = 'mcp:operator:read mcp:operator:write mcp:operator:admin';

/** Run the operator MCP OAuth consent and code exchange, and return the access token for `scope`. */
export async function operatorMcpOAuthToken(
  app: FastifyInstance,
  sessionToken: string,
  tenantId: string,
  scope: string,
): Promise<string> {
  const registered = await app.inject({
    method: 'POST',
    url: '/api/v1/tenant/mcp/oauth/register',
    payload: { redirect_uris: [REDIRECT] },
  });
  const clientId = (registered.json() as { client_id: string }).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const grant = await app.inject({
    method: 'POST',
    url: '/api/v1/tenant/mcp/oauth/grant',
    headers: { authorization: `Bearer ${sessionToken}` },
    payload: {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope,
      tenant_id: tenantId,
      approve: true,
    },
  });
  const redirect = (grant.json() as { data: { redirect: string } }).data.redirect;
  const token = await app.inject({
    method: 'POST',
    url: '/api/v1/tenant/mcp/oauth/token',
    payload: {
      grant_type: 'authorization_code',
      code: new URL(redirect).searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: clientId,
    },
  });
  return (token.json() as { access_token: string }).access_token;
}
