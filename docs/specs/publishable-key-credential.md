# Spec — Publishable Key as a First-Class Browser Credential

Status: **Built** (2026-06-29, all 3 resolutions applied; 462 api tests green) · Owner: platform · Surface change → PR, auto-merge OFF, human review.

## 1. Problem

The public key (`rp_pub_<slug>_<random>`) is **stranded scaffolding**. It is generated at
Application creation, stored, and documented as a browser credential — but **no route
accepts it**. `requireApiKey` rejects every `rp_pub_*` with `401 API_KEY_INVALID`
(`apps/api/src/middleware/api-key-auth.ts:59-69`). The code comments describe the
intended-but-unbuilt behaviour verbatim (`apps/api/src/lib/keys.ts:5-9`: "The SDK uses it
to call public, unauthenticated-from-server endpoints (sign-in widgets, plan listing,
etc.)").

Consequences today:

1. **No backendless auth.** Browser sign-in/sign-up requires the **secret** key, which can
   only live on a server. A pure SPA / mobile / desktop app must run a backend proxy just
   to log a user in. The React provider doc comment admits it: "Auth state changes … are
   usually handled by the customer's server" (`packages/sdk-react/src/context.tsx`).
2. **Secret-key leakage pit-of-failure.** In `@relipay/react` the secret key is the *only*
   key that does anything, so AI codegen and junior devs wire `sk_` into client bundles to
   make it work — leaking a full server credential.
3. **License verify needs a backend.** `POST /api/v1/licenses/verify` is `billing:write`
   secret-gated (`licenses.routes.ts:30`), so a desktop/client app can't verify its own
   license key without shipping a secret key.
4. **No rotation.** The public key is generated once, embeds the immutable slug, has no
   endpoint / UI / schema support to roll. If a customer ever treats it as a credential and
   it leaks, there is no recovery.

## 2. Decision

Complete the original design: make the publishable key a **first-class browser credential**
that gates a fixed set of **public-bootstrap** routes. Threat model = Stripe `pk_` / Supabase
anon / Clerk publishable: the key is **identity, not authorization**. It names the
Application and asserts "legit public client"; it grants nothing by itself. Safety comes from
(a) the gated operations being inherently public, (b) the existing brute-force + rate limits,
(c) the per-app **CORS origin allowlist** (`Application.corsOrigins`, already in schema).

## 3. Route tiers

### 3a. Public-bootstrap routes — accept `rp_pub_*` AND secret key

The pre-user, inherently-public operations. Pub key OR secret key both valid here.

| Module | Routes | Today's guard |
|---|---|---|
| auth | `/sign-up`, `/sign-in`, `/mfa-verify`, `/refresh`, `/sign-out`, `/forgot-password`, `/reset-password`, `/magic-link/request`, `/magic-link/verify`, `/passkey/authenticate/start`, `/passkey/authenticate/complete`, `/verify-email`, `/send-verification` | `requireApiKey` + `auth:write` |
| oauth | `/:provider/start`, `/:provider/callback` | `requireApiKey` + `auth:write` |
| licenses | `/verify` | `requireApiKey` + `billing:write` |
| billing | `/plans` (catalog read) | `requireApiKey` + `billing:read` |

NB: `/refresh`, `/sign-out` operate on a user refresh token the caller already holds — safe
under a public client. `/sign-in` etc. still require the user's own password/email/passkey —
the pub key does not bypass that.

### 3b. Secret-only routes — unchanged, reject `rp_pub_*`

Everything that moves money or mutates privileged state: `billing/checkout`,
`billing/subscription` writes, `usage/record`, `credits/consume`, `licenses` **issuance**,
org management, `GET /me`, all `auth:read`/account-management routes requiring an existing
user token (`/change-password`, `/passkeys*`, `/sessions*`, `/sign-out-everywhere`). The
existing `requireScope` + `requireUserSession` chain stays. Reaffirms decisions.md:684 —
"secret-key-gated writes never see the user token."

## 4. API changes

### 4.1 New middleware `requirePublishableOrSecretKey`

Add to `apps/api/src/middleware/api-key-auth.ts`. Behaviour:

1. Read `Authorization: Bearer <key>` (existing). Also accept pub key via
   `Authorization: Bearer rp_pub_…` — single header, prefix-routed.
2. If prefix `rp_live_`/`rp_test_` → delegate to existing secret-key path (hash verify, IP
   allowlist, scope, `dataMode`).
3. If prefix `rp_pub_` → **publishable path**:
   - Look up Application by `publicKey` (unique, plaintext — `O(1)` indexed; no hash).
     Constant-time-compare not required (public value), but use exact unique lookup.
   - **Origin enforcement**: if `application.corsOrigins` is non-empty, the request `Origin`
     header MUST be in it → else `403 ORIGIN_NOT_ALLOWED`. (Browsers always send `Origin` on
     cross-origin + same-origin POST; server callers that present a pub key won't send one —
     for them, empty `corsOrigins` = allow, non-empty = they must match or use a secret key.)
   - Attach `request.application`. Set `request.dataMode` — pub key has no live/test split,
     so derive mode from a query/header? **Decision: pub key is LIVE-only** for now; test
     flows use the secret test key server-side. (Open question — see §8.)
   - Set a marker `request.authKind = 'publishable'` so downstream scope checks can branch.
   - Rate-limit by `publicKey` + IP (reuse the Redis limiter from decisions.md:545).
4. Anything else (super-admin key, junk) → existing `401 API_KEY_INVALID`.

`requireScope` must treat a publishable request as holding only an implicit
**public scope set** (e.g. `auth:write` for bootstrap, `billing:read` for plans,
`billing:write` *only* for `licenses/verify`). Simplest: gate by route membership in
`PUBLIC_BOOTSTRAP_ROUTES` rather than threading scopes — a publishable request is allowed
**iff** the route is in the bootstrap set. Implement as the middleware, not as scope grants,
so a pub key can never satisfy `requireScope` on a secret-only route.

### 4.2 Wire bootstrap plugins

Swap the plugin-level `app.addHook('onRequest', requireApiKey)` on the bootstrap auth plugin
(`auth.routes.ts:185`), oauth start/callback, `licenses/verify`, and `billing/plans` to
`requirePublishableOrSecretKey`. Leave account-management auth plugin (`auth.routes.ts:592`,
the user-token routes) on `requireApiKey`.

### 4.3 Rotation endpoint + grace window

A pub key is **baked into shipped client bundles you cannot force-update** (old app
versions, cached SPAs, desktop installs). So rotation is **dual-key**, not a cutover.

- Schema (additive migration):
  ```prisma
  // On Application:
  previousPublicKey          String?   @unique @map("previous_public_key")
  previousPublicKeyValidUntil DateTime? @map("previous_public_key_valid_until")
  ```
- `POST /api/v1/tenant/applications/:id/rotate-public-key` (tenant session, OWNER/ADMIN):
  1. Move current `publicKey` → `previousPublicKey`, set `previousPublicKeyValidUntil = now + graceDays` (default 30, body-overridable, max e.g. 90).
  2. Mint new `publicKey = generatePublicKey(slug)` (slug preserved → key still identifiable).
  3. Write `app.public_key.rotated` security event (mirror `app.api_key.revoked` pattern, decisions.md:532).
  4. Return new key (no "show once" needed — it's public).
- Publishable lookup in §4.1 accepts `publicKey` OR (`previousPublicKey` AND
  `previousPublicKeyValidUntil > now`). After expiry the old key 401s.
- Idempotency-Key supported (mirror api-key create, `tenant-applications.routes.ts:428`).

## 5. SDK changes

### 5.1 `@relipay/react`

- `RelipayProvider({ apiUrl, publishableKey, … })` — new required `publishableKey` prop.
- `RelipayBrowserClient({ apiUrl, publishableKey })` — send
  `Authorization: Bearer ${publishableKey}` on bootstrap calls (sign-in/up, magic-link,
  passkey-authenticate, license verify, plans). For already-authenticated user calls, keep
  `X-Relipay-User-Token`. Both headers may coexist: pub key = "which app + public client",
  user token = "which user".
- New client methods so a SPA needs **no backend**: `signIn`, `signUp`, `requestMagicLink`,
  `verifyMagicLink`, passkey-authenticate, `verifyLicense`, `getPlans`.
- Drop the doc-comment claim that sign-in "is usually handled by the customer's server" —
  it no longer has to be.

### 5.2 `@relipay/node` / `@relipay/nextjs`

No functional change — secret-key path untouched. Update READMEs (§6).

### 5.3 shared-types

Add `publishableKey` to provider/client config types; add rotation DTO.

## 6. Docs changes (land in the SAME PR)

Current docs are misleading; do **not** edit them ahead of the API or they describe an
unbuilt feature. Edit together with the code:

- `docs/api-keys.md` — replace the vague "browser, public reads" line with the real model:
  publishable key = browser identity credential for **public-bootstrap routes** (list them),
  what it can't do (no money/privileged writes), origin-allowlist requirement, rotation +
  grace window.
- `docs/api-key-rotation.md` — add a publishable-key section: dual-key grace window, why it
  differs from secret rotation (shipped-bundle problem), how to roll one.
- `docs/concepts.md` — pub key promoted from "embedded identifier" to "browser credential."
- `docs/quickstart.md` — add a backendless SPA quickstart using `publishableKey`.
- `packages/sdk-react/README.md` — show direct sign-in with the publishable key, no proxy.
- `packages/sdk-node/README.md`, `packages/sdk-nextjs/README.md` — fix the vestigial pub-key
  mentions to point at the now-real React flow.
- `docs/errors.md` — document `ORIGIN_NOT_ALLOWED`.

## 7. Security review checklist

- [ ] Pub key cannot satisfy `requireScope` on any secret-only route (route-membership gate, not scope grant).
- [ ] Origin allowlist enforced when `corsOrigins` set; documented that empty = open (rate-limited).
- [ ] Brute-force limiter keyed on pub key + IP; sign-in still requires the user secret.
- [ ] Rotation grace window can't be set to ∞; old key hard-expires.
- [ ] `app.public_key.rotated` event recorded; rotation OWNER/ADMIN-only.
- [ ] License verify with pub key still requires a valid license key as the actual entitlement bearer.
- [ ] No `dataMode` confusion — pub key is LIVE-only (or resolve §8).

## 8. Resolutions (decided 2026-06-29)

1. **Test mode for pub key → LIVE-only.** No `rp_pub_test_` variant. A publishable request
   always sets `request.dataMode = 'LIVE'`. NB this is a real (accepted) limitation: test
   keys are NOT symbolic — `dataMode` enforces hard test/live data isolation
   (`user-session.ts:96` 403s on mode mismatch; `EndUser`/`Subscription`/`Payment`/credits
   carry a `mode` column). So browser-only apps cannot exercise **test-mode** user flows;
   those still require a server-side `rp_test_` secret. Acceptable — test integration usually
   has a dev backend.
2. **Origin enforcement when `corsOrigins` empty → allow (open, rate-limited).** Tenants add
   origin protection afterward in the panel. Panel should show an advisory when empty.
3. **Phase split → build everything together.** Routes accept pub key + React SDK + rotation
   endpoint + grace window + **panel rotation UI** + docs, in one PR. Surface change →
   auto-merge OFF, human review.
