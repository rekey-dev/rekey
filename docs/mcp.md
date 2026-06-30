# MCP server — operator + integrator guide

ReliPay hosts **two MCP surfaces**:

1. **Per-Application end-user MCP** at `/api/v1/mcp/<slug>` — end-users sign
   into one of your Applications via OAuth 2.1 + PKCE and read their own
   account through four tools. Full RFC 8414 / 9728 / 7591 stack.
2. **Operator MCP** at `/api/v1/tenant/mcp` — workspace operator reads their
   own workspace (applications, end-users, payments, webhook health, security
   events). Two auth paths: OAuth 2.1 + PKCE with workspace picker at consent
   (preferred), or PAT-Bearer with an `rp_op_…` token (headless / non-browser).

The full operator-facing guide is published at
[**relipay.dev/docs/mcp**](https://relipay.dev/docs/mcp). This file is the
repo-level cross-reference for developers working on the API itself.

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
| AS service — issuer URL, discovery metadata, token mint, registration | `apps/api/src/modules/mcp/oauth.service.ts` |
| MCP JSON-RPC handler — `initialize`, `tools/list`, `tools/call`, `ping` | `apps/api/src/modules/mcp/mcp-server.ts` |
| Tool definitions (the four read-only account tools) | `apps/api/src/modules/mcp/account-tools.ts` |
| Per-Application gate (`authConfig.mcpEnabled`) | `apps/api/src/modules/mcp/oauth.service.ts` (`resolveMcpApp`) |
| Panel UI — operator-side toggle + setup card | `apps/panel/src/app/(authed)/applications/[id]/mcp/page.tsx` |
| Marketing page — public guide | `apps/marketing/src/app/docs/mcp/page.tsx` |
| Tests | `apps/api/test/mcp.test.ts` |

## URL layout

For an Application with slug `<slug>`, given `PUBLIC_WEBHOOK_BASE_URL=https://api.relipay.dev`:

| Concern | URL |
|---|---|
| MCP endpoint (JSON-RPC over HTTP POST) | `https://api.relipay.dev/api/v1/mcp/<slug>` |
| Authorization-server metadata (RFC 8414) | `…/api/v1/mcp/<slug>/.well-known/oauth-authorization-server` |
| Protected-resource metadata (RFC 9728) | `…/api/v1/mcp/<slug>/.well-known/oauth-protected-resource` |
| Path-insertion form (RFC 8414 §3) | `https://api.relipay.dev/.well-known/oauth-authorization-server/api/v1/mcp/<slug>` |
| Dynamic client registration (RFC 7591) | `…/api/v1/mcp/<slug>/oauth/register` (POST) |
| Authorization endpoint | `…/api/v1/mcp/<slug>/oauth/authorize` (GET + POST) |
| Token endpoint | `…/api/v1/mcp/<slug>/oauth/token` (POST) |
| Introspection (RFC 7662) | `…/api/v1/mcp/<slug>/oauth/introspect` (POST) |

The MCP endpoint replies `401` + `WWW-Authenticate: Bearer resource_metadata="<protected-resource-url>"`
on unauthenticated calls, so any RFC-compliant MCP client auto-discovers the rest of the flow.

## Scopes + grants

| Field | Value |
|---|---|
| `scopes_supported` | `["mcp:account"]` — read the signed-in user's own data |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` (PKCE mandatory) |
| `token_endpoint_auth_method` (per client) | `"none"` (public client; PKCE replaces the secret) |

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
or [relipay.dev/docs/mcp](https://relipay.dev/docs/mcp) for the full
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
operator PATs (`rp_op_…`).

### Where the code lives

| Concern | File |
|---|---|
| Route + JSON-RPC dispatch | `apps/api/src/modules/tenant-mcp/tenant-mcp.routes.ts` |
| MCP server (initialize / tools/list / tools/call / ping) | `apps/api/src/modules/tenant-mcp/tenant-mcp-server.ts` |
| Operator tool definitions | `apps/api/src/modules/tenant-mcp/operator-tools.ts` |
| Bearer-PAT guard | `apps/api/src/middleware/operator-token-auth.ts` (reused — same hook that gates `/api/v1/tenant/operator/*`) |
| Panel UI — connection guide | `apps/panel/src/app/(authed)/account/mcp/page.tsx` |

### Auth model

Single endpoint, single guard: `resolveOperatorToken` from the existing
operator-PAT middleware. No new auth path, no new credential.

- PAT verification is a SHA-256 hash lookup against the unique
  `TenantApiToken.tokenHash` index — no scan, no timing oracle.
- Membership is re-checked on every request. Removing the operator from
  the workspace instantly invalidates every PAT bound to it.
- Required scope: `read` (the default scope every PAT has). Write tools, when
  added, will demand explicit scopes via `requireOperatorScope('…:write')`.
- Workspace scoping is structural — `TenantApiToken.tenantId` binds a PAT to
  exactly one workspace, so every tool sees only that workspace's data.

### Tools

| Tool | Notes |
|---|---|
| `get_workspace_overview` | counts + MRR per currency |
| `list_applications` | per-app endUserCount, activeSubs, apiRequestsLast24h |
| `list_members` | operators in workspace + role |
| `recent_payments` | filter by `status`, `limit` |
| `recent_subscriptions` | filter by `status`, `limit` |
| `recent_security_events` | filter by `actorType`, `limit` |
| `recent_webhook_events` | filter by `provider`, `onlyFailed`, `limit` |
| `recent_failed_webhook_deliveries` | last-N FAILED outbound deliveries |
| `application_health` | per-app payment success rate (30d) + outbound webhook success rate (24h), sorted by failure count |

All READ-ONLY. No tool returns refresh tokens, password hashes, license keys,
or provider credentials.

### OAuth 2.1 AS (Phase 2 — shipped)

Mirrors the per-Application MCP's OAuth shape, scoped to operators picking a
workspace at consent.

| Concern | File |
|---|---|
| OAuth routes (register / authorize / token / introspect / well-known) | `apps/api/src/modules/tenant-mcp/oauth.routes.ts` |
| OAuth service (PKCE verify, code mint, token issue, refresh rotation) | `apps/api/src/modules/tenant-mcp/oauth.service.ts` |
| Access-token signing + verify | `apps/api/src/lib/operator-mcp-jwt.ts` (JWT `typ: 'op_mcp_access'`, audience-bound to issuer URL) |
| Hybrid Bearer guard (PAT OR JWT) on the MCP endpoint | `apps/api/src/modules/tenant-mcp/bearer-auth.ts` |

#### URL layout (issuer = `https://api.relipay.dev/api/v1/tenant/mcp`)

| Concern | URL |
|---|---|
| Authorization-server metadata (RFC 8414) | `…/.well-known/oauth-authorization-server` |
| Protected-resource metadata (RFC 9728) | `…/.well-known/oauth-protected-resource` |
| Dynamic client registration (RFC 7591) | `POST …/oauth/register` |
| Authorization (login + workspace pick + consent) | `GET/POST …/oauth/authorize` |
| Token (auth-code + refresh) | `POST …/oauth/token` |
| Introspection (RFC 7662) | `POST …/oauth/introspect` |

#### Scopes + grants

| Field | Value |
|---|---|
| `scopes_supported` | `["mcp:operator:read"]` |
| `response_types_supported` | `["code"]` |
| `grant_types_supported` | `["authorization_code", "refresh_token"]` |
| `code_challenge_methods_supported` | `["S256"]` |
| `token_endpoint_auth_methods_supported` | `["none"]` (public client; PKCE replaces the secret) |

#### Schema

Three new tables added in migration `20260531230000_operator_mcp_oauth`:

- `tenant_oauth_clients` — RFC 7591 dynamically-registered clients (id, name, redirect_uris, metadata, created_at).
- `tenant_oauth_auth_codes` — single-use 60s codes bound to `(clientId, tenantUserId, tenantId, redirectUri, codeChallenge, scope)`.
- `tenant_mcp_refresh_tokens` — hash-only refresh tokens bound to `(tenantUserId, tenantId, clientId)`; atomically rotated on redeem (reuse → revocation).

#### Token shape

```ts
{ typ: 'op_mcp_access', sub: tenantUserId, tid: tenantId, cid: clientId, scope, aud: '<issuer>', iat, exp }
```

Audience-bound to the operator MCP issuer URL — a token signed for this surface won't verify against the per-Application MCP audience (different signing key + different audience).
