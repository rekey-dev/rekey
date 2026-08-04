# MCP server — operator + integrator guide

Rekey hosts **two MCP surfaces**:

1. **Per-Application end-user MCP** at `/api/v1/mcp/<slug>` — end-users sign
   into one of your Applications via OAuth 2.1 + PKCE and read their own
   account through four tools. Full RFC 8414 / 9728 / 7591 stack.
2. **Operator MCP** at `/api/v1/tenant/mcp` — workspace operator reads their
   own workspace (applications, end-users, payments, webhook health, security
   events). Two auth paths: OAuth 2.1 + PKCE with workspace picker at consent
   (preferred), or PAT-Bearer with an `rp_op_…` token (headless / non-browser).

The full operator-facing guide is published at
[**rekey.dev/docs/mcp**](https://rekey.dev/docs/mcp). This file is the
repo-level cross-reference for developers working on the API itself.

The per-Application OAuth AS described below is also the deployment's **OpenID
Provider** when `authConfig.oidcEnabled` is set — same issuer, same clients,
same grant, plus a discovery document, `id_token` and `/userinfo`. See
[docs/oidc-provider.md](oidc-provider.md); the two toggles are independent.

## TL;DR

```
panel  →  Applications  →  <app>  →  MCP tab  →  Enable MCP
        copy the MCP URL → paste into your client → user signs in → done.
```

## Where the code lives

| Concern | File |
|---|---|
| OAuth AS routes (mounted at `/api/v1/mcp/:slug/oauth/*` + `/.well-known/*`) | `apps/api/src/modules/mcp/mcp.routes.ts` |
| Path-insertion well-known routes (RFC 8414 / 9728 root-level) | `apps/api/src/modules/mcp/mcp.well-known.routes.ts` |
| AS service — issuer URL, discovery metadata, scope grant, token mint, registration | `apps/api/src/modules/mcp/oauth.service.ts` |
| OIDC layer — provider metadata, ID Token, identity claims | `apps/api/src/modules/mcp/oidc.service.ts` |
| MCP JSON-RPC handler — `initialize`, `tools/list`, `tools/call`, `ping` | `apps/api/src/modules/mcp/mcp-server.ts` |
| Tool definitions (the four read-only account tools) | `apps/api/src/modules/mcp/account-tools.ts` |
| Per-Application gate (`authConfig.mcpEnabled`) | `apps/api/src/modules/mcp/oauth.service.ts` (`resolveMcpApp`) |
| Panel UI — operator-side toggle + setup card | `apps/panel/src/app/(authed)/applications/[id]/mcp/page.tsx` |
| Marketing page — public guide | `apps/marketing/src/app/docs/mcp/page.tsx` |
| Tests | `apps/api/test/mcp.test.ts` |

## URL layout

For an Application with slug `<slug>`, given `PUBLIC_WEBHOOK_BASE_URL=https://api.rekey.dev`:

| Concern | URL |
|---|---|
| MCP endpoint (JSON-RPC over HTTP POST) | `https://api.rekey.dev/api/v1/mcp/<slug>` |
| Authorization-server metadata (RFC 8414) | `…/api/v1/mcp/<slug>/.well-known/oauth-authorization-server` |
| Protected-resource metadata (RFC 9728) | `…/api/v1/mcp/<slug>/.well-known/oauth-protected-resource` |
| Path-insertion form (RFC 8414 §3) | `https://api.rekey.dev/.well-known/oauth-authorization-server/api/v1/mcp/<slug>` |
| Dynamic client registration (RFC 7591) | `…/api/v1/mcp/<slug>/oauth/register` (POST) — see the toggle below |
| Authorization endpoint | `…/api/v1/mcp/<slug>/oauth/authorize` (GET + POST) |
| Token endpoint | `…/api/v1/mcp/<slug>/oauth/token` (POST) |
| Introspection (RFC 7662) | `…/api/v1/mcp/<slug>/oauth/introspect` (POST) |

The MCP endpoint replies `401` + `WWW-Authenticate: Bearer resource_metadata="<protected-resource-url>"`
on unauthenticated calls, so any RFC-compliant MCP client auto-discovers the rest of the flow.

## Scopes + grants

| Field | Value |
|---|---|
| `scopes_supported` | `["mcp:account"]` — read the signed-in user's own data. Prefixed with `openid`/`profile` when the Application also has `oidcEnabled`, and `email` on top of that when it has `requireEmailVerification` ([why](oidc-provider.md#why-email-needs-requireemailverification)). |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` (PKCE mandatory) |
| `token_endpoint_auth_method` (per client) | `"none"` (public client; PKCE replaces the secret) |

The MCP JSON-RPC endpoint requires the `mcp:account` scope on the presented
token — a token granted only OIDC scopes gets `403 insufficient_scope`.

A request naming scopes this AS cannot grant is refused with `invalid_scope` at
the authorization endpoint. Only a request naming **no** `scope` parameter at
all falls back to `mcp:account`, which is the pre-OIDC behaviour MCP clients
depend on. (`scope=openid` against an MCP-only Application used to hit that
fallback and receive a working `mcp:account` token.)

### Dynamic client registration

`POST /oauth/register` is governed by `authConfig.dynamicClientRegistration`,
**default `true`**. With it off the endpoint answers `403
CLIENT_REGISTRATION_DISABLED` and `registration_endpoint` disappears from both
discovery documents; existing clients keep working. Leave it open for MCP —
clients self-register as their first act — and close it once the clients that
need to exist do, especially on an Application that is also an OpenID Provider.

## Tools

All zero-argument; scoped to `(applicationId, endUserId)` of the access token.

| Tool | Returns |
|---|---|
| `get_profile` | `{ id, email, emailVerified, role, metadata, createdAt }` |
| `get_subscription` | `{ status, provider, currentPeriodEnd, cancelAt, plan } \| null` (ACTIVE or PAST_DUE only) |
| `get_credits` | `{ balance }` (unit-less) |
| `list_licenses` | `{ licenses: [{ id, kind, status, seatsAllowed, expiresAt, createdAt }] }` (no keys) |

No tool returns license keys, password hashes, provider credentials, or any
other Application's data.

## Connecting

See [`apps/marketing/src/app/docs/mcp/page.tsx`](../apps/marketing/src/app/docs/mcp/page.tsx)
or [rekey.dev/docs/mcp](https://rekey.dev/docs/mcp) for the full
end-user-facing setup (Claude Code CLI, Claude Desktop `mcp.json`, Cursor,
custom HTTP client, hand-rolled curl walkthrough).

## Per-app kill switch

Bumping `Application.tokenGeneration` invalidates every MCP access token issued
for that Application immediately. Clients see `401` + a fresh challenge and
re-run the OAuth flow.

## Tests

`apps/api/test/mcp.test.ts` covers:

- `mcpEnabled` gating (404 when off, 200 when on)
- RFC 8414 metadata discovery (both suffix + path-insertion forms)
- RFC 9728 protected-resource metadata
- RFC 7591 dynamic client registration (redirect-URI allowlist, public-client shape)
- PKCE enforcement (S256 only)
- Authorization-code flow end-to-end
- Refresh-token rotation
- Audience binding (tokens for app A rejected by app B)
- `tokenGeneration` kill-switch

---

## Operator MCP

Mounted at `/api/v1/tenant/mcp`. JSON-RPC over HTTP POST. Bearer-authed by
**either** an operator PAT (`rp_op_…`) or an OAuth 2.1 access token
(`typ: op_mcp_access`) — one hybrid guard covers both.

### Where the code lives

| Concern | File |
|---|---|
| Route + JSON-RPC dispatch | `apps/api/src/modules/tenant-mcp/tenant-mcp.routes.ts` |
| MCP server (initialize / tools/list / tools/call / ping) | `apps/api/src/modules/tenant-mcp/tenant-mcp-server.ts` |
| Operator tool definitions | `apps/api/src/modules/tenant-mcp/operator-tools.ts` |
| Operator tool definitions (writes) | `apps/api/src/modules/tenant-mcp/operator-write-tools.ts` |
| Hybrid bearer guard (PAT **or** OAuth JWT) | `apps/api/src/modules/tenant-mcp/bearer-auth.ts` |
| PAT resolution (shared with `/api/v1/tenant/operator/*`) | `apps/api/src/middleware/operator-token-auth.ts` |
| Panel UI — connection guide | `apps/panel/src/app/(authed)/account/mcp/page.tsx` |

### Auth model

Two credentials, one hybrid guard (`tenant-mcp/bearer-auth.ts`): a PAT resolved
via `resolveOperatorToken`, or an OAuth JWT verified by
`lib/operator-mcp-jwt.ts`. The PAT was Phase 1; OAuth landed in Phase 2 so
an operator's Claude Desktop / Cursor client can run the browser flow instead of
being handed a long-lived secret to paste.

- PAT verification is a SHA-256 hash lookup against the unique
  `TenantApiToken.tokenHash` index — no scan, no timing oracle.
- Membership is re-checked on every request, on **both** paths. Removing the
  operator from the workspace instantly invalidates every token bound to it.
- Read tools need `read` (the default scope every PAT has) or
  `mcp:operator:read`. Two of them additionally carry a role floor:
  `list_invitations` and `recent_security_events` are `minRole: 'ADMIN'`, so a
  MEMBER cannot pull the workspace security log through an agent when the HTTP
  route refuses them. `minRole` is honoured on read tools, not only writes.
- Write tools are default-deny on two independent axes: write capability
  (`mcp:operator:write` on the OAuth path, `applications:write` for a PAT) **and**
  a workspace role clearing the tool's `minRole` (ADMIN unless the tool says
  otherwise). Both are re-checked at call time, not only at `tools/list`, so a
  dispatch bug can't turn into an unauthorized write.
- Workspace scoping is structural — `TenantApiToken.tenantId` (or the JWT's
  `tid`) binds a token to exactly one workspace, so every tool sees only that
  workspace's data.

### Read tools (`operator-tools.ts`)

| Tool | Notes |
|---|---|
| `get_workspace_overview` | counts + MRR per currency |
| `list_applications` | per-app endUserCount, activeSubs, apiRequestsLast24h |
| `list_members` | operators in workspace + role |
| `list_invitations` | pending workspace invitations — **`minRole: ADMIN`** |
| `recent_payments` | filter by `status`, `limit` |
| `recent_subscriptions` | filter by `status`, `limit` |
| `recent_security_events` | filter by `actorType`, `limit` — **`minRole: ADMIN`** |
| `recent_webhook_events` | filter by `provider`, `onlyFailed`, `limit` |
| `recent_failed_webhook_deliveries` | last-N FAILED outbound deliveries |
| `application_health` | per-app payment success rate (30d) + outbound webhook success rate (24h), sorted by failure count |
| `get_end_user` | one end-user: verification state, app environment, current subscription |

No read tool returns refresh tokens, password hashes, license keys, or provider
credentials.

### Write tools (`operator-write-tools.ts`)

Hidden from `tools/list` unless the caller has write capability **and** the role,
and re-checked on `tools/call`:

`create_application`, `update_auth_config`, `create_plan`, `update_plan`,
`set_plan_active`, `create_webhook_endpoint`, `update_webhook_endpoint`,
`invite_member`, `revoke_invitation`, `change_member_role`, `remove_member`.

Two more are flagged `admin`, needing `mcp:operator:admin` rather than plain
write: `configure_billing_provider` (the secret travels through the MCP client)
and `cancel_subscription` (irreversible).

Still not exposed at any tier: delete application, refund, webhook-secret
rotation.

Each goes through the same service the panel uses — no MCP-only write path — and
emits a security event on success, so an agent's writes are as auditable as a
human's.

### OAuth 2.1 AS (Phase 2 — shipped)

Mirrors the per-Application MCP's OAuth shape, scoped to operators picking a
workspace at consent.

| Concern | File |
|---|---|
| OAuth routes (register / authorize / grant / token / introspect / well-known) | `apps/api/src/modules/tenant-mcp/oauth.routes.ts` |
| OAuth service (PKCE verify, code mint, token issue, refresh rotation) | `apps/api/src/modules/tenant-mcp/oauth.service.ts` |
| Access-token signing + verify | `apps/api/src/lib/operator-mcp-jwt.ts` (JWT `typ: 'op_mcp_access'`, audience-bound to issuer URL) |
| Hybrid Bearer guard (PAT OR JWT) on the MCP endpoint | `apps/api/src/modules/tenant-mcp/bearer-auth.ts` |

#### URL layout (issuer = `https://api.rekey.dev/api/v1/tenant/mcp`)

| Concern | URL |
|---|---|
| Authorization-server metadata (RFC 8414) | `…/.well-known/oauth-authorization-server` |
| Protected-resource metadata (RFC 9728) | `…/.well-known/oauth-protected-resource` |
| Dynamic client registration (RFC 7591) | `POST …/oauth/register` — open by default; `OPERATOR_MCP_DYNAMIC_REGISTRATION=disabled` closes it (403 `CLIENT_REGISTRATION_DISABLED`, and `registration_endpoint` drops out of the metadata). Close it once your clients are connected: registration grants no access on its own, but it allowlists a `redirect_uri` of the registrant's choosing, which is what a consent-phishing link needs. |
| Authorization (redirects the operator to the panel to sign in + pick a workspace) | `GET …/oauth/authorize` — **GET only**; `POST` here is a 404 |
| Consent decision (the panel posts the operator's approval back) | `POST …/oauth/grant` — guarded by `requireTenantSession`, i.e. a panel **session** token; a PAT is deliberately not accepted, because consent is a human act |
| Token (auth-code + refresh) | `POST …/oauth/token` |
| Introspection (RFC 7662) | `POST …/oauth/introspect` |

The consent screen names the **host the authorization code will be delivered to**
— the registered `redirect_uri`'s origin — and marks it as not vouched for by
this deployment. That is the paired mitigation for leaving registration open by
default: the one thing on the screen that is not the operator's own is now the
thing the screen points at.

#### Scopes + grants

| Field | Value |
|---|---|
| `scopes_supported` | `["mcp:operator:read", "mcp:operator:write", "mcp:operator:admin"]` |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["none"]` (public client; PKCE replaces the secret) |

#### Schema

Three new tables added in migration `20260531230000_operator_mcp_oauth`:

- `tenant_oauth_clients` — RFC 7591 dynamically-registered clients (id, name, redirect_uris, metadata, created_at).
- `tenant_oauth_auth_codes` — single-use 60s codes bound to `(clientId, tenantUserId, tenantId, redirectUri, codeChallenge, scope)`.
- `tenant_mcp_refresh_tokens` — hash-only refresh tokens bound to `(tenantUserId, tenantId, clientId)`; atomically rotated on redeem. Replaying an **already-rotated** token revokes the whole family — every live token for that `(tenantUserId, tenantId, clientId)` triple, not just the replayed one — because on a leak the attacker rotates first and the replay is the legitimate client arriving second. A token that was deliberately revoked (sign-out) is refused without burning anything.

#### Token shape

```ts
{ typ: 'op_mcp_access', sub: tenantUserId, tid: tenantId, cid: clientId, scope, aud: '<issuer>', iat, exp }
```

Audience-bound to the operator MCP issuer URL — a token signed for this surface won't verify against the per-Application MCP audience (different signing key + different audience).
