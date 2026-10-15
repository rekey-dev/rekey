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
- The list's filters (`status`, `environment`, `q`, `sort`) run inside the same grant scope, and so does its `total`, so "Show disabled (N)" in the panel counts only what the member can open. `include=summary` adds `activeApiKeys` only where the member holds `developer:read` and `lastActiveOn` only where they hold `overview:read`. `lastActiveOn` counts end-user activity, plus an API key's last use only where the member also holds `developer:read`. `sort=activity` orders by the same figure the member may read, so the order cannot reveal what the field hides.
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
say *what kinds of data* they may touch there, workspace-wide. Eight domains,
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
| `audience` | lists and the contacts on them (newsletter, waitlist, contact form) |

The grant roles are presets over the same vocabulary: `APP_VIEWER` is every
domain at read except `audience`, `APP_ADMIN` every domain at write,
`APP_BILLING` is `billing:write` plus every read except `auth-config` and
`audience`. Contacts are people who never signed up, so a viewer or billing
grant never reaches them; give someone `APP_ADMIN` on the Application to let
them see its lists. A request's effective
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
POST /api/v1/tenant/auth/resend-verification                     ← mails another confirmation link, replacing earlier ones
POST /api/v1/tenant/auth/verify-email            { token }          ← confirms this account's address; changes nothing else
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

### Confirming an operator's email address

Sign-up asks for no proof of the address, so a new operator is unconfirmed (`user.emailVerified: false` on `GET /tenant/auth/me`). Three rules follow.

**1. The confirmation email ratifies the sign-up, for whoever is signed in to the account, and changes nothing else.** Sign-up mails a link to `{PANEL_URL}/verify-email?token=…`. Confirming sets `emailVerified` and nothing else: the password, sessions, passkeys, personal access tokens and MCP grants all stay, and no session is issued.

Because it keeps the password, the link is not enough by itself. `POST /tenant/auth/verify-email` takes the token **and a session of the account the token was mailed for**: without a session it answers 401 `TENANT_SESSION_MISSING`, with another account's 403 `EMAIL_VERIFICATION_WRONG_ACCOUNT` (the link is not used up). The reason is who receives the mail. The link goes to the mailbox, and the person reading it may not be the person who created the account. Someone who can sign in already holds the password, so keeping it takes nothing from them. Someone who cannot sign in has no business ratifying a password a stranger chose, and their own routes in (an emailed sign-in link, a provider, a reset) replace it instead, as rule 3 describes. The panel page follows this: signed out, it offers "I created this account: sign in and confirm" (which comes back to the page) and "I did not create it: email me a sign-in link"; signed in, it asks for a press of "Confirm email" and spends the token only then, so a mail scanner that opens the link confirms nothing.

The link works once and for 24 hours. `POST /tenant/auth/resend-verification` (signed in) sends another, which replaces any earlier unused link; it counts against the per-recipient auth email cap, and the panel's notice has a button for it. After a confirmation the address is mailed a short notice (`operator_email_confirmed`, not counted against the cap) that says to reset the password if this was not you.

**2. Until the address is confirmed, the operator cannot create lasting access.** These answer 403 `EMAIL_NOT_VERIFIED`, and the `fix` names the ways to confirm that exist on the deployment:

| Refused while unconfirmed | Where |
|---|---|
| Invite someone to the workspace | `POST /tenant/workspace/invitations`, MCP `invite_member` |
| Change a member's role or scopes, or grant them an Application | `PATCH /tenant/workspace/members/:id`, `PUT …/members/:id/grants`, MCP `change_member_role` |
| Create another workspace | `POST /tenant/workspace/` |
| Mint an Application API key, rotate the publishable key | `POST …/api-keys`, `POST /tenant/operator/applications/:id/api-keys` (personal access token), `POST …/rotate-public-key`, MCP `mint_api_key` |
| Create or change a webhook endpoint, rotate its secret | `POST`/`PATCH …/webhooks`, `…/rotate-secret`, MCP `create_webhook_endpoint`, `update_webhook_endpoint` |
| Store or change billing provider credentials, register a provider webhook | `PUT`/`PATCH …/billing-credentials/:provider`, `…/register-webhook`, MCP `configure_billing_provider` |
| Configure a sign-in provider | `PUT …/oauth-config/:provider` |
| Change `appUrl` or `redirectUrls` | `PATCH …/auth-config`, MCP `update_auth_config` (other fields stay open) |
| Change the IP allowlist and CORS origins | `PUT …/access` |
| Set email credentials, the sender, or a built-in email template | `PUT …/email-credentials`, `PATCH …/email-sender`, `PUT …/email-templates/:eventKey` |
| Add a passkey, turn on two-factor authentication | `/tenant/auth/passkeys/register/*`, `/tenant/auth/mfa/setup*` |
| Create a personal access token, approve an MCP client | `POST /tenant/auth/api-tokens`, `POST /tenant/mcp/oauth/grant` |

Everything else stays open, so a new operator can look around before confirming: creating Applications, plans, prices, coupons, meters and roles, managing end users, reading everything, revoking and deleting, and accepting an invitation into someone else's workspace. The rule is "does this create access that outlives my session, or a copy of user data sent somewhere": if yes, it waits.

**3. Proving the mailbox another way takes the account.** A magic-link sign-in, a Google or GitHub sign-in, an accepted ID Token handoff or a completed password reset on an unconfirmed operator marks the address verified and removes what was set before it: the password (a reset replaces it), every session, passkeys, a second factor, personal access tokens, MCP grants, and invitations that account sent and nobody accepted. Application API keys that operator minted are revoked and webhook endpoints it created are switched off (not deleted), for keys and endpoints created from 2.2.0 on, which record who made them. Workspace memberships stay, and **other members are never removed automatically**. The security event `auth.unverified_account_claimed` is recorded in the operator's first workspace; its `metadata.review` lists, for each workspace the account owns or administers, the account's role there, every other member (name, email, role) and the number of Applications, live API keys, enabled webhook endpoints and configured billing providers, with how many of those keys and endpoints have no recorded creator (`unattributedApiKeys`, `unattributedWebhookEndpoints`): those were not revoked or switched off, because nothing says whose they are. Impersonation sessions the account had open are ended. The address is mailed the `operator_account_claimed` notice with the same list and the instruction to review it, whenever something was removed or there is something to review. An Application the first registrant created is left in place with its users, plans, sign-in settings and email templates; Applications cannot be deleted, so the notice says to disable any you did not create (Application, Settings, "Disable application"). The ID Token handoff sends no notice: its accounts are provisioned with a password nobody was shown.

Which to use: **the confirmation email**, if you created the account. It keeps everything. If someone else registered your address you cannot use it (you cannot sign in to their account), and should not want to; sign in by emailed link, Google or GitHub, or reset the password, so that whatever they set is removed, then review the workspace as the notice says.

**A deployment that gives operators no way to prove a mailbox does not refuse.** That is one with no deployment mail (`RESEND_DEFAULT_API_KEY` and `RESEND_DEFAULT_FROM`), no operator sign-in provider (`PANEL_OAUTH_*`), no ID Token handoff (`OPERATOR_OIDC_*`) and, in development, no `REKEY_DEV_ECHO_AUTH_TOKENS=true`: a fresh self-hosted install. Nobody can ever arrive there by proving a mailbox, so there is nothing to take over, and refusing would leave the CLI and the MCP server without a token for good. The refusals start the moment you configure any of those. `GET /tenant/auth/me` reports this as `emailConfirmation.required`, and `emailConfirmation.byEmail` says whether a confirmation link can be mailed; on a deployment with a sign-in provider but no mail, `resend-verification` answers 409 `OPERATOR_CONFIRMATION_EMAIL_UNAVAILABLE` and the operator confirms by signing in with the provider.

An unconfirmed operator that already has two-factor authentication is neither wiped nor marked verified by a sign-in link or a provider until the code is given; a correct code marks the address verified and keeps everything. A password reset confirms nothing for such an operator, because it gives no session in which to ask for the code. The confirmation email works for them like for anyone.

Accepting a workspace invitation does not confirm an address. The inviter is shown the invitation link, so holding it proves nothing about the mailbox.

Operators who signed up with a password before 2.2.0 are unconfirmed unless they have already signed in by emailed link, Google or GitHub (which marked them verified at the time). The upgrade confirms nobody. The rest see the panel notice and confirm with the emailed link, which keeps their password, personal access tokens and MCP grants. Their existing tokens keep working for everything not in the table above in the meantime.

Reset, sign-in-link and invitation mail to one operator address is capped at 5 an hour and 15 a UTC day (`AUTH_EMAIL_RECIPIENT_HOURLY_CAP`, `AUTH_EMAIL_RECIPIENT_DAILY_CAP`). Over it the reset and sign-in-link routes answer with their usual body and send nothing; an invitation is still created and its link returned, without the mail.

## Invitation flow

> Invitations are **unique-per-recipient single-use links with an expiry**, not domain-restricted "anyone with this link" links: a link that admits any address on a shared domain such as `@gmail.com` admits strangers.

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
