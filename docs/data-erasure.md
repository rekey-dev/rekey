# Data erasure (GDPR right to be forgotten)

Rekey supports two distinct ways to remove an end-user, with very different
guarantees. Pick the right one:

| Operation | Route | What happens |
|---|---|---|
| **Plain delete** (back-compat) | `DELETE …/end-users/:euid` | Cascade-deletes the EndUser row **and every dependent row**, including financial records, via the schema's `onDelete: Cascade` FKs. Use only when you genuinely want everything gone (e.g. test data). |
| **Erasure** (GDPR Art. 17) | `DELETE …/end-users/:euid?erasure=true` | **Tombstones** the user: hard-deletes PII/auth material, **retains anonymized** financial records. The GDPR-correct default for a data-subject erasure request. |

Both require the **workspace OWNER** role. No per-application grant unlocks
either, and neither does ADMIN.

That is a change. Erasure used to be OWNER/ADMIN, and the plain delete used to
be the per-application `write` grant alone — which a MEMBER holding `APP_ADMIN`
satisfies. So the operation that *retains* the accounting record was gated
harder than the one that destroys it, and the more destructive of the two was
reachable by the least privileged role that can reach the Application at all.

Erasure is **irreversible**. A plain delete is irreversible *and* takes the
financial history with it.

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
| `LicenseActivation` | **retain + scrub** | Rows kept for seat accounting. `machineFingerprint` tombstoned to `erased:<id>`, `label` and `deviceId` cleared, and the seat released. Scoped to the subject's own activations: every activation on a licence they hold, plus those on an org-pooled licence of an organization they belong to that name one of their devices. Another user's activation that happens to carry the same fingerprint is not touched; devices are unique per user, so a shared fingerprint is not evidence of a shared person. |
| `Device` | **hard-delete** | A machine fingerprint the person supplied is personal data; sessions and activations that pointed at the device are SET NULL. |
| `CreditLedger` | **retain + scrub** | Append-only journal kept. `metadata` cleared, `description` → null. Deltas/balances untouched. |
| `CreditBalance` | **retain** | Numeric balance only — no free-form PII to scrub. Kept via FK. |
| `UsageRecord` | **retain + scrub** | Kept (scalar `endUserId`, scoped by meter). `metadata` cleared. Quantities/timestamps untouched. |
| `OrganizationMembership` | **retain** | Not PII about the subject; left intact (team rosters). The tombstone keeps the FK valid. |
| `SecurityEvent` | **retain, bounded** | Security audit trail (including the erasure event itself) is retained for forensics indefinitely by default, or for `LOG_RETENTION_DAYS` when that is set, then pruned. Erasure does not scrub these rows, so their `ip` and `user_agent` go to the log archive when one is configured. See "The log archive" below. |
| `EmailLog` | **retain + scrub** | Rows kept: send counts and outcomes are operational data. On every row of A sent to one of E's addresses, `to_address` becomes the tombstone address, `subject` becomes `[erased]` (templates interpolate variables into it, so it can hold a name), and any copy of the address inside `error` is replaced with the tombstone. `event_key`, `via`, `status`, `message_id` and timestamps untouched. |
| `EmailSuppression` | **delete** | Suppression rows for E's addresses in A are deleted. See "Suppressions" below for why they are not kept as a hash. |
| `WebhookDelivery` | **retain + scrub** | Rows, status, attempts and response kept. Deliveries are matched by E's **id** at the places Rekey's own events put it (`data.user.id`, `data.userId`, `data.endUserId`, and `endUserId` under `data.device`, `data.subscription`, `data.payment`, `data.dunningCase`, `data.license`, `data.credit`), never by searching payloads for text. In a matched payload: `email` becomes the tombstone address, a device `fingerprint` becomes `erased`, `metadata` / `label` / `description` become null, and any other copy of the address is replaced. `updated_at` is not bumped, so the retention clock is unchanged. |
| `WebhookEvent` | **retain + scrub** | Inbound billing receipts (the provider's own event body). They carry no Rekey end-user id, so they are matched by E's address within A, and only occurrences of that address are replaced with the tombstone; other fields the provider sent (a billing name or postal address) are not interpreted. Set `WEBHOOK_EVENT_RETENTION_DAYS` to bound how long those survive. Nothing replays a stored receipt, so the rewrite changes no billing state. |
| `ImpersonationAudit` | **retain** | Operator-accountability trail — retained. |
| `DunningCase` | **retain** | Denormalized `endUserId` (no FK); part of the billing record. |
| Redis brute-force lock | **delete** | `bf:fail:` / `bf:lock:eu:login:<appId>:<email>` for the erased address. The key embeds the email in plaintext and the super-admin locked-accounts dashboard enumerates those keys, so a surviving lock would keep the address readable for the rest of its 15-minute TTL. Best-effort, outside the transaction (Redis can't join it). |

> Erasure is **idempotent**: erasing an already-tombstoned user is a no-op (the
> response carries `alreadyErased: true`). All mutations run in one transaction,
> with a 60-second timeout: the email and webhook scrubs are proportional to how
> much the person was ever mailed or announced, and a half-applied erasure is
> worse than a slow one. Only E's own rows are locked while it runs.

**Which addresses count as E's.** The account's address at the moment of
erasure, plus any address an outstanding email-verification or magic-link token
names (an email change mails the new address before the account holds it). An
address another end-user of A currently holds is excluded. An address E used and
changed away from before any of those tokens existed is not known to Rekey any
more, so rows sent to it are not matched. Every match is scoped to A: the same
address in another Application is a different data subject and is not touched.

## Suppressions

A suppression row exists so an Application never mails an address again. Erasure
**deletes** E's suppression rows rather than keeping a hashed address to go on
refusing it.

- A hash of an email address is still personal data. Anyone holding a candidate
  address can hash it and test for a match, so a kept hash would be pseudonymised
  data about a person the operator has promised to forget, not erased data.
- The person the suppression protected no longer exists in A. If the same address
  signs up again, that is a new account and a new consent, and the operator can
  suppress it again.
- A bounce or complaint suppression is the strongest case for keeping one. The
  transport keeps its own bounce and complaint list (Resend, SES and most SMTP
  relays suppress hard bounces and complaints on their side), which erasure does
  not touch, so a returning address that hard-bounced still does not get mail
  delivered. Rekey's list is an operator-maintained layer on top of that.

If your policy requires that an address which complained is never mailed again
even after erasure, record that outside Rekey before erasing.

## The log archive

With `LOG_RETENTION_DAYS` and `LOG_ARCHIVE_S3_*` set, `security_events`,
`email_logs` and `webhook_deliveries` rows are uploaded to the bucket as full rows
before they are pruned. How that interacts with erasure:

- **Rows archived after an erasure** carry the scrubbed values. Erasure rewrites
  rows in place in the database, so by the time the retention sweep reads an
  email log or a delivery of E's, the address is already the tombstone.
- **Rows archived before an erasure** keep the personal data they had when they
  were uploaded. Erasure cannot reach the bucket: an email log uploaded last month
  still holds E's address, and an archived `security_events` row still holds the
  `ip` and `user_agent` (those are not scrubbed in the database either).
- So an operator using the archive **must apply their own retention to it**.
  Give the bucket a lifecycle rule no longer than your erasure deadline, and do
  not enable Object Lock unless you have decided erasure never applies to the
  archive.

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
