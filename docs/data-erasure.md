# Data erasure (GDPR right to be forgotten)

Rekey supports two distinct ways to remove an end-user, with very different
guarantees. Pick the right one:

| Operation | Route | What happens |
|---|---|---|
| **Plain delete** (back-compat) | `DELETE …/end-users/:euid` | Cascade-deletes the EndUser row **and every dependent row**, including financial records, via the schema's `onDelete: Cascade` FKs. Use only when you genuinely want everything gone (e.g. test data). |
| **Erasure** (GDPR Art. 17) | `DELETE …/end-users/:euid?erasure=true` | **Tombstones** the user: hard-deletes PII/auth material, **retains anonymized** financial records. The GDPR-correct default for a data-subject erasure request. |

Both are OWNER/ADMIN-only for erasure (plain delete keeps the per-app `write`
grant). Erasure is **irreversible**.

## Why tombstone instead of hard-delete?

Two obligations collide:

1. **Erase the person's data** (GDPR Art. 17 — name, email, credentials, login
   identities, devices).
2. **Retain financial records** — invoices/payments are subject to tax and
   accounting retention laws (commonly 6–10 years). A naive hard-delete that
   cascades away `Payment` / `Subscription` / `License` / `CreditLedger` rows
   would violate those.

The retained financial rows FK to `EndUser` with `onDelete: Cascade`. Deleting
the `EndUser` would cascade them away. So instead we **keep the `EndUser` row as
a tombstone** (PII stripped, `erasedAt` set) purely to preserve FK integrity for
the retained financial rows — and we strip any PII duplicated into those rows'
free-form `metadata` / `description` fields. The canonical email lives only on
the (now anonymized) `EndUser`.

A tombstoned user can **never authenticate again** — see "Auth enforcement".

## The cascade guarantee — per model

For an erasure of end-user `E` in application `A`:

| Model | Action | Detail |
|---|---|---|
| `EndUser` | **anonymize (tombstone)** | `email` → `erased+<id>@deleted.invalid`, `emailVerified` → false, `passwordHash` → null, `metadata` → null, `role` → `"user"`, `erasedAt`/`erasedBy` set. Row **kept**. |
| `OAuthIdentity` | **delete** | All of E's provider links removed. |
| `RefreshToken` | **delete** | All sessions (session + mcp kinds) removed → existing sessions die. |
| `MfaCredential` | **delete** | TOTP secret + backup codes gone. |
| `WebAuthnCredential` | **delete** | All passkeys removed. |
| `MagicLinkToken` | **delete** | Any outstanding magic links removed. |
| `PasswordResetToken` | **delete** | Any outstanding reset tokens removed. |
| `EmailVerificationToken` | **delete** | Any outstanding verification tokens removed. |
| `OAuthAuthCode` | **delete** | Any unredeemed per-Application OAuth/OIDC authorization codes removed. 60-second TTL, so usually none — but a code minted moments earlier is a live credential. |
| `Subscription` | **retain + scrub** | Rows kept (FK to tombstone). `metadata` JSON cleared (`{}`). Status/plan/amounts untouched. |
| `Payment` | **retain + scrub** | Rows kept. `metadata` cleared, `description` → null. Amount/currency/status/provider ref untouched. |
| `License` | **retain + scrub** | Rows kept. `metadata` cleared. Key hash/prefix/status untouched. |
| `CreditLedger` | **retain + scrub** | Append-only journal kept. `metadata` cleared, `description` → null. Deltas/balances untouched. |
| `CreditBalance` | **retain** | Numeric balance only — no free-form PII to scrub. Kept via FK. |
| `UsageRecord` | **retain + scrub** | Kept (scalar `endUserId`, scoped by meter). `metadata` cleared. Quantities/timestamps untouched. |
| `OrganizationMembership` | **retain** | Not PII about the subject; left intact (team rosters). The tombstone keeps the FK valid. |
| `SecurityEvent` | **retain** | Security audit trail (including the erasure event itself) is retained for forensics. |
| `ImpersonationAudit` | **retain** | Operator-accountability trail — retained. |
| `DunningCase` | **retain** | Denormalized `endUserId` (no FK); part of the billing record. |
| Redis brute-force lock | **delete** | `bf:fail:` / `bf:lock:eu:login:<appId>:<email>` for the erased address. The key embeds the email in plaintext and the super-admin locked-accounts dashboard enumerates those keys, so a surviving lock would keep the address readable for the rest of its 15-minute TTL. Best-effort, outside the transaction (Redis can't join it). |

> Erasure is **idempotent**: erasing an already-tombstoned user is a no-op (the
> response carries `alreadyErased: true`). All mutations run in one transaction.

## Auth enforcement

A tombstoned user (`erasedAt` set) is rejected on **every** authentication path
with HTTP `410 END_USER_ERASED`:

- **Sign-in** — `passwordHash` is cleared, so password verify fails; the
  session-minting chokepoint (`issueSessionOrMfaChallenge`) also rejects.
- **Magic-link** — the consume path mints through the same chokepoint; the
  tombstoned email also no longer matches a magic link issued for the old email.
- **OAuth sign-in / OAuth link** — same session-minting chokepoint.
- **Refresh** — erasure revokes all refresh tokens; any token that races through
  rotation is rejected when the user is re-read.
- **Any still-unexpired access token** — `requireUserSession` resolves the
  current user through `authService.getById`, which rejects erased users, so a
  pre-erasure access token stops working the moment it's next used.

The per-Application **OAuth 2.1 / OpenID Connect surface** enforces the identical
rule, in the dialect its clients parse rather than the Rekey envelope — an OAuth
client cannot read a `{ success: false, error: { code } }` body, so `410
END_USER_ERASED` would be indistinguishable from a bug:

- **`grant_type=authorization_code`** — `invalid_grant`, even for a code minted
  before the erasure (they are also deleted above, so this is the backstop).
- **`grant_type=refresh_token`** — `invalid_grant`. The window here is the
  30-day refresh chain, not the 60 seconds of a code.
- **`/oauth/userinfo`** — `401 invalid_token`.
- **`POST /api/v1/mcp/<slug>`** — `401 invalid_token`, before any tool runs.
  `get_profile` returns the user's metadata, so a 15-minute access-token
  lifetime was not an acceptable grace period.

## Observability

- **Security event:** `end_user.erased` (actor = operator) with per-model counts.
- **Outbound webhook:** `user.erased` — payload `data.user` = `{ id, erasedAt }`.
  Use it to propagate the erasure to your own copies of the user's PII. (See the
  webhook events registry — `WEBHOOK_EVENTS` from `@rekey.dev/node` — and
  [billing.md → Webhooks](billing.md).)

## Panel

End-user detail page → danger zone → **"Erase (GDPR)"**. A typed confirmation
(type the user's email) guards the action, with a note that financial records
are retained anonymized. An **"erased"** badge + an "Already erased" disabled
state appear once the user is tombstoned.
