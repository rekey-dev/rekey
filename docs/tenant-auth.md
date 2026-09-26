# Operator Auth + Team Workspaces

This is how **operators** (the humans who use the Rekey panel) sign in and manage their workspaces. It is distinct from **end-user auth** (`docs/auth.md`) — that's how the customers' users sign into the customers' apps.

## Mental model

```
TenantUser (operator)
  ├── TenantMembership ──→ Tenant (workspace)
  │     role = OWNER | ADMIN | MEMBER
  └── … many memberships (Slack-style)

Tenant (workspace)
  ├── many TenantMembership (the people in this workspace)
  ├── many TenantInvitation (pending links to bring more in)
  └── many Application (the customer-facing products this workspace ships)
```

One operator can belong to many Tenants. The active workspace is encoded in the JWT (`tid` claim), not the row — switching workspaces re-issues tokens with a different `tid`. The session's refresh token remembers it too, so a refresh keeps the operator in the workspace they switched to (or the one an invitation accept put them in); if they have since been removed from it, the refresh falls back to their oldest workspace.

## Roles

| Role | Can |
|---|---|
| `OWNER` | Invite anyone in any role · remove anyone · change anyone's role · delete the workspace · everything ADMIN can |
| `ADMIN` | Invite ADMIN/MEMBER · remove MEMBERs · change MEMBER roles · CRUD Applications + Plans + Coupons + API keys |
| `MEMBER` | **No Application access by default** — access is granted per Application (below). Read the workspace member list; nothing else. |

A workspace **always has at least one OWNER**. Removing or demoting the last OWNER fails with `CANNOT_REMOVE_LAST_OWNER`.

## Per-application grants (MEMBER scoping + billing-manager role)

Workspace roles are coarse. For agencies (many client Applications in one
workspace) and finance staff (manage plans, never rotate keys), a `MEMBER`
membership can carry **per-application grants** (`ApplicationGrant` rows,
unique per member+application):

| App role | On the granted Application |
|---|---|
| `APP_ADMIN` | Full read/write on that app (API keys, auth config, end-users, webhooks, email, …) — everything OWNER/ADMIN can do there **except** the extra-sensitive routes listed below |
| `APP_BILLING` | Billing manager: read everything **except auth config** (redacted in app payloads) · write plans, plan entitlements, coupons, and manual credit grants · cannot mint API keys, touch credentials, or manage users |
| `APP_VIEWER` | Read-only |

Semantics:

- **OWNER/ADMIN never consult grants** — implicit full access to every Application (unchanged).
- A `MEMBER` with **zero grants sees no Application at all.** This is the default a freshly accepted invitation lands in: `GET /tenant/applications` returns `[]`, and every `/tenant/applications/:id/*` route answers `404 APPLICATION_NOT_FOUND`. **Grants are additive from nothing** — a member has exactly the Applications somebody granted them, and no others.
- Grants are always authoritative: an Application without a grant disappears from `GET /tenant/applications` (which also feeds the panel sidebar and command palette) and returns `404 APPLICATION_NOT_FOUND` on direct access — deliberately the same answer an absent Application gives, so a denied app is not an enumeration oracle. Insufficient grant *level* on a granted app → `403 APP_ACCESS_DENIED`.
- Removing a member's **last** grant leaves them with nothing, not with workspace-wide read. De-scoping a member never widens their access.
- Grants survive role changes but are only consulted while the role is `MEMBER` (promote to ADMIN → inert; demote back → re-armed). Setting a grant on an OWNER/ADMIN membership is rejected with `APP_GRANT_MEMBER_ONLY`.
- Workspace-level surfaces are unaffected: team/workspace/audit-log writes stay OWNER/ADMIN-only, and the extra-sensitive per-app routes (request log, end-user DSAR export, impersonation, and granting or cancelling a subscription) remain OWNER/ADMIN-only even for `APP_ADMIN` grant holders.
- Stricter still, **workspace OWNER only**: deleting an end-user and GDPR-erasing one (`DELETE /tenant/applications/:id/end-users/:euid`, both forms). No grant unlocks either, and neither does ADMIN. The plain delete cascades through the financial records; erasure retains them anonymized. See [data-erasure.md](data-erasure.md).

> **Grandfathered memberships.** Fail-closed became the default in 2.0.0-rc.3.
> Memberships that already existed **and held no grant** at upgrade time were
> backfilled with `TenantMembership.legacyWorkspaceRead = true`, which preserves
> the old behaviour for them: read-only on every Application in the workspace,
> with writes still refused as `TENANT_ROLE_INSUFFICIENT`. Flipping those members
> to "access nothing" during an upgrade would have revoked, unannounced, access
> their colleagues were using.
>
> The flag is reported per member on `GET /tenant/workspace/members` so an owner
> can find everyone still on it, and it is **cleared permanently the first time
> any grant is set** on that membership — after which the member is on the normal
> grant-scoped rules, including when their last grant is later removed. New
> memberships are always created with the flag `false`.

Managed via (OWNER/ADMIN only). A member sees their own resolved scopes on `GET /tenant/auth/me` and their own grants on the applications they reach; the members list shows a member their teammates' names and roles, not their permissions.

```
GET    /api/v1/tenant/workspace/members/:membershipId/grants
PUT    /api/v1/tenant/workspace/members/:membershipId/grants                  { applicationId, role }   ← upsert
DELETE /api/v1/tenant/workspace/members/:membershipId/grants/:applicationId
```

Enforcement lives in `apps/api/src/lib/app-access.ts` (`ensureAppAccess(req, appId, 'read' | 'write' | 'billing-write')`), called by every `/tenant/applications/:id/*` route.

## Scopes (narrowing a MEMBER inside their grants)

A grant says *which* Applications a member reaches and at what level. Scopes
say *what kinds of data* they may touch there, workspace-wide. Seven domains,
each at `read` or `write` (`write` implies `read`):

| Domain | Covers |
|---|---|
| `end-users` | end-users, sessions, devices, credits, support actions |
| `billing` | plans, subscriptions, payments, coupons, invoices, provider settings, entitlement overrides |
| `auth-config` | sign-in configuration and its secrets |
| `developer` | API keys, webhooks, request logs, email transport |
| `organizations` | organizations, roles, memberships |
| `activity` | security events for the application |
| `overview` | dashboard counts (never money) |

The grant roles are presets over the same vocabulary: `APP_VIEWER` is every
domain at read, `APP_ADMIN` every domain at write, `APP_BILLING` is
`billing:write` plus every read except `auth-config`. A request's effective
set is the **intersection** of the grant preset on that Application and the
membership's scopes, so neither can widen the other. A personal access token
or MCP token is capped by its holder's scopes at request time.

Rules:

- **Scopes narrow `MEMBER` only.** OWNER and ADMIN hold every scope whatever
  the row says; role is the ceiling and is checked before scopes everywhere,
  REST and MCP alike. Promoting a member to ADMIN clears their stored scopes;
  setting scopes on an OWNER/ADMIN is refused with `SCOPES_MEMBER_ONLY`.
- **Unrestricted is the default.** A membership starts with no restriction,
  which resolves to every scope; that changes nothing until an admin restricts
  somebody, because without a grant there is no Application to apply it to.
- A scoped route the member may see (they hold a grant) but not use answers
  `403 SCOPE_INSUFFICIENT` naming the scope. An Application they hold no
  grant on still answers `404 APPLICATION_NOT_FOUND`; the scope check runs
  after the existence and grant checks, never before.
- Some things no scope unlocks: grants, roles and invitations, application
  lifecycle, impersonation, DSAR export and erasure, workspace settings. A
  `team:write` scope on a member would let them grant themselves everything,
  so it does not exist.
- Mixed reads project rather than refuse: `GET /tenant/applications/:id`
  redacts sign-in configuration without `auth-config:read`; the end-user list
  refuses `?subscriptionStatus=` without `billing:read` rather than ignoring
  it; the MCP workspace overview omits MRR without `billing:read`.
- Unknown scope names are refused with `SCOPE_INVALID`, naming them.

Set on the membership (OWNER/ADMIN only; `null` lifts every restriction):

```
PATCH /api/v1/tenant/workspace/members/:membershipId   { scopes: ["end-users:write", "organizations:read"] | null }
```

The same route takes `role`; a promotion sent together with `scopes` is
refused up front rather than half-applied. The panel exposes the editor on
**Team**; a member's resolved scopes are on `GET /tenant/auth/me` and on the
`access` field of each application read, which is what the panel renders its
navigation from.

### What a freshly accepted member can reach

Verified against a running deployment, for a member accepted with the default
invitation (role `MEMBER`, no grants, no scopes):

| Surface | Answer |
|---|---|
| `GET /tenant/applications` | `[]` |
| Any `/tenant/applications/:id/*` route, including every billing read and write | `404 APPLICATION_NOT_FOUND` |
| `GET /tenant/security-events`, `GET /tenant/workspace/limits` | `403 TENANT_ROLE_INSUFFICIENT` |
| `GET /tenant/workspace/members` | teammates' emails and roles only; no grants, no scopes |
| `GET /tenant/workspace` | name and whether operator MCP is on |
| Operator MCP tools | listed (their scopes are unrestricted), but `list_applications` is empty, the overview is all zeros, and any tool naming an Application answers not found |

So no billing data is exposed by default. It becomes reachable only when an
admin grants the member an Application, and the grant level plus the member's
scopes decide how much of it; an `APP_VIEWER` grant with `billing` at
`None` shows a support agent the end-users of that Application and nothing
they pay.

**Invitations carry the role only.** Grants and scopes cannot be set on an
invitation yet, so they are applied on the Team page after acceptance. Because
a member with no grant reaches no Application, there is no window in which a
new member sees data they were not meant to; the admin sets the scopes in the
same edit that grants the first Application.

### Switching the operator MCP server off for a workspace

Independently of scopes, a workspace can refuse every operator MCP credential
bound to it: `PATCH /api/v1/tenant/workspace { operatorMcpEnabled: false }`
(OWNER/ADMIN; also on the panel's Workspace settings). Off refuses access
tokens at auth with `403 OPERATOR_MCP_DISABLED` and grants no new consent;
nothing is revoked, and refresh tokens keep rotating, so on again restores
every agent as it was. Flipping it is a `workspace.operator_mcp_switched`
security event.

## JWT shape

```
{ sub: <tenantUserId>, tid: <tenantId>, rol: 'OWNER' | 'ADMIN' | 'MEMBER', iat, exp }
```

`tid` and `rol` are load-bearing. Every authenticated tenant request:

1. Verifies the JWT signature.
2. Refetches membership for `(sub, tid)` from the DB — if the user was removed since the token was issued, the request is rejected with `TENANT_MEMBERSHIP_REVOKED`.
3. Uses the **live** role from the membership row, not the JWT's `rol` — this means role downgrades take effect immediately on the next request.

Lifetimes: the access token lasts `OPERATOR_ACCESS_TOKEN_TTL_SECONDS`
(default 15 minutes, up to 12 hours) and the refresh token
`OPERATOR_REFRESH_TOKEN_TTL_DAYS` (default 30, up to 365), sliding on every
rotation. The panel renews the access token silently when it expires, so an
operator is signed in for as long as their refresh token keeps rotating; the
access lifetime bounds how long a removed member can keep acting before the
next renewal re-checks the membership, which is why the default is short.
Every auth response carries `accessTokenExpiresAt` and
`refreshTokenExpiresAt`, and the panel sets its session cookies from them.
A password change or reset, sign-out everywhere, or refresh-token reuse stamps
the operator, and an access token minted before the stamp is refused on its
next use, so a long access lifetime never extends an ended session. The same
paths revoke every operator MCP OAuth refresh token the operator holds, and an
operator MCP access token issued before the stamp is refused, so a connected
MCP client has to be authorized again. Revoking
one session (`DELETE /tenant/auth/sessions/:id`) does not stamp: the access
token carries the session in its `sid` claim and is refused once that session
is revoked, while the operator's other sessions and MCP connections keep
working.

Refresh-token reuse means a rotated token presented again. The one exception
is a race: a token replayed within `REFRESH_TOKEN_REUSE_WINDOW_SECONDS` (15 by
default) of its rotation, while its replacement is still unused, answers
`REFRESH_TOKEN_RACED` and revokes nothing (two panel tabs or two panel
instances refreshing at once, a retry after a lost response). Nothing is
issued to the replayer, and the replay is recorded as an
`operator.refresh_token_raced` security event.

## Endpoints

### Unauthenticated

```
POST /api/v1/tenant/auth/sign-up        { email, password, workspaceName, name? }
POST /api/v1/tenant/auth/sign-in        { email, password }
POST /api/v1/tenant/auth/refresh        { refreshToken }
POST /api/v1/tenant/auth/sign-out       { refreshToken }
POST /api/v1/tenant/auth/forgot-password { email }
POST /api/v1/tenant/auth/reset-password  { token, newPassword }
GET  /api/v1/tenant/invitations/preview?token=…   ← lets a recipient see the workspace + role before signing up
```

### Authenticated (`Authorization: Bearer <accessToken>`)

```
GET  /api/v1/tenant/auth/me                      → user + memberships + active
POST /api/v1/tenant/auth/switch-workspace        { tenantId }       → new pair scoped to target
POST /api/v1/tenant/auth/change-password         { currentPassword, newPassword }
POST /api/v1/tenant/auth/sign-out-everywhere

GET    /api/v1/tenant/workspace/members                            ← any role
DELETE /api/v1/tenant/workspace/members/:id                        ← OWNER/ADMIN
PATCH  /api/v1/tenant/workspace/members/:id      { role }          ← OWNER/ADMIN

GET    /api/v1/tenant/workspace/invitations                        ← OWNER/ADMIN
POST   /api/v1/tenant/workspace/invitations      { email, role }   ← OWNER/ADMIN, returns one-time-show token
DELETE /api/v1/tenant/workspace/invitations/:id                    ← OWNER/ADMIN

GET    /api/v1/tenant/workspace/email-logs                         ← OWNER/ADMIN

POST   /api/v1/tenant/invitations/accept         { token }         → joins workspace + new session

GET    /api/v1/tenant/applications
POST   /api/v1/tenant/applications               { name, slug, billingProvider? }
GET    /api/v1/tenant/applications/:id
GET/POST/DELETE /api/v1/tenant/applications/:id/api-keys[/keyId]
GET/POST/PATCH  /api/v1/tenant/applications/:id/plans[/slug]
GET/POST/PATCH  /api/v1/tenant/applications/:id/coupons[/code]
```

The invitation list and `email-logs` sit at the OWNER/ADMIN floor their sibling
writes already had: `email-logs` carries every operator's address plus the
subject and delivery status of workspace mail, which is the same class of thing
`GET /tenant/security-events` is ADMIN-only for. `GET /workspace/members` is
deliberately left open to every role — seeing the team roster is ordinary
collaboration, and it is also how a member reads their own grants.

## Self-serve sign-up flow

```
POST /api/v1/tenant/auth/sign-up
  { email, password, workspaceName: "Acme Co" }
   ↓
   Atomically (single transaction):
     1. INSERT TenantUser
     2. INSERT Tenant
     3. INSERT TenantMembership { role: OWNER }
     4. Issue session
   ↓
returns { user, memberships: [Acme Co (OWNER)], activeTenantId, accessToken, refreshToken }
```

## Invitation flow (the one the user explicitly requested)

> Per the user's call: invitations are **unique-per-recipient single-use links with an expiry** — not domain-restricted "anyone with this link" links. We learned that `@gmail.com` invites cause havoc.

```
OWNER/ADMIN does:
  POST /api/v1/tenant/workspace/invitations  { email, role }
  → { invitation: {...}, token: "…raw…", warning: "shown once" }

  They share `${PANEL_URL}/accept-invite?token=${raw}` via email/Slack/whatever.

Recipient:
  GET /api/v1/tenant/invitations/preview?token=…
  → { tenantName, role, invitedEmail, expiresAt }   ← what they're agreeing to

  (signs up if they don't have an account yet, then:)

  POST /api/v1/tenant/invitations/accept   { token }
   Authorization: Bearer <their accessToken>
  → atomically: marks consumed, creates membership, issues fresh session scoped to the joined workspace.
```

Properties:

- **Single-use.** Replaying an accepted token returns `INVITATION_NOT_USABLE`.
- **7-day expiry by default.**
- **Hash-only DB** — the raw token leaves the server exactly once at creation.
- **Acceptance is bound to the invited address.** The accepting session's email must equal the invitation's `email`, case-insensitively; anything else is refused with `403 INVITATION_EMAIL_MISMATCH`. Invite links travel by email and chat and are trivially forwarded, so "whoever holds the link" would mean a forwarded link is a workspace takeover at the invited role — up to OWNER.
- **Concurrent-accept safe** — the consume + membership-create happen in one transaction.

## Multi-workspace sessions

Sign-in returns the user's full memberships list. The default active workspace is the oldest one (deterministic). The panel stores this list to render a workspace switcher.

To switch:

```
POST /api/v1/tenant/auth/switch-workspace { tenantId }
  → returns a fresh {access, refresh} pair with the new tid + role
```

The old tokens stay valid until they naturally expire. The panel discards them client-side. (We deliberately don't auto-revoke — losing all your other tabs on switch is a worse UX.)

## SUPER_ADMIN_KEY didn't go away

It's still useful for:

- Bootstrap on a brand-new deploy (mint the very first Tenant + Application via curl)
- Ops escape hatch (debug, support, recovery if every operator account is locked out)

Day-to-day uses operator login. The `/api/v1/admin/*` routes (super-admin) and `/api/v1/tenant/*` routes (operator) coexist — same data, different access models.

## What's deliberately not here yet

- **Workspace deletion** — destructive op needs a confirmation flow + soft-delete period.

Operator OAuth (Google / GitHub), TOTP MFA, passkeys and the audit log have all shipped — `modules/tenant-oauth`, `modules/tenant-mfa`, `modules/tenant-passkeys`, and the panel's `(authed)/audit-log`. Listed here only so the gap isn't re-filed.
