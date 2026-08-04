# Social sign-in on rekey.dev — what the owner has to create

Everything in the code is done. What is missing is two OAuth clients, which can
only be created by a human with access to the Google and Discord consoles. This
page is that checklist.

Nothing here applies to self-hosted deployments. It is specifically about the
Rekey Cloud `account` Application — the one whose end-users are rekey.dev
buyers.

---

## 0. The one string that has to match in three places

For each provider, the **redirect URI** appears in three systems and is compared
byte-for-byte by the provider during the token exchange. A trailing slash, a
`www.`, or `http` instead of `https` is a hard failure, and the error the
provider returns says `invalid_client` or `redirect_uri_mismatch` — it does not
tell you which character is wrong.

| Provider | Redirect URI |
| --- | --- |
| Google | `https://rekey.dev/api/auth/oauth/google/callback` |
| Discord | `https://rekey.dev/api/auth/oauth/discord/callback` |

Those come from `oauthCallbackUrl()` in
`apps/marketing/src/lib/oauth-providers.ts` and are pinned by a test, so they
cannot drift without CI noticing.

---

## 1. Google

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
under the project that owns rekey.dev:

1. **APIs & Services → OAuth consent screen.** External. App name `Rekey`,
   support email, logo, homepage `https://rekey.dev`, privacy policy
   `https://rekey.dev/privacy`, terms `https://rekey.dev/terms`.
   Authorized domain: `rekey.dev`.
   Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` —
   these are the three the provider requests by default and none of them needs
   Google verification.
2. **Credentials → Create credentials → OAuth client ID.**
   - Application type: **Web application**
   - Name: `Rekey Cloud — rekey.dev`
   - Authorized JavaScript origins: `https://rekey.dev`
   - Authorized redirect URIs: `https://rekey.dev/api/auth/oauth/google/callback`
3. Copy the **Client ID** and **Client secret**.

> Publish the consent screen. While it is in "Testing" only the accounts on the
> test-user list can sign in, and everyone else gets `access_denied` — which
> rekey.dev renders as "Sign-in was cancelled", so it looks like the buyer's
> fault rather than a configuration state.

## 2. Discord

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. **New Application** → name `Rekey`.
2. **OAuth2 → Redirects → Add Redirect**:
   `https://rekey.dev/api/auth/oauth/discord/callback`
3. **OAuth2 → Client information**: copy the **Client ID**, then **Reset Secret**
   and copy the **Client Secret**.

Scopes are `identify` and `email`, requested by the provider implementation —
nothing to select in the portal.

---

## 3. Paste them into the Application

Two calls, one per provider, against the Cloud `account` Application. These need
a **tenant session** (Panel → Application → OAuth), not the Application secret
key.

```
PUT /api/v1/tenant/applications/<accountAppId>/oauth-config/google
{
  "clientId":     "<from Google>",
  "clientSecret": "<from Google>",
  "redirectUri":  "https://rekey.dev/api/auth/oauth/google/callback"
}
```

```
PUT /api/v1/tenant/applications/<accountAppId>/oauth-config/discord
{
  "clientId":     "<from Discord>",
  "clientSecret": "<from Discord>",
  "redirectUri":  "https://rekey.dev/api/auth/oauth/discord/callback"
}
```

The secret is encrypted at rest (`oauthCredentialsCiphertext`); only the client
id and redirect URI live in the readable `oauthConfig` column.

## 4. Turn the buttons on

On the marketing Dokploy unit:

```
CLOUD_OAUTH_PROVIDERS=google,discord
```

Then redeploy marketing.

**Order matters.** This variable is what renders the buttons, and it is empty by
default precisely so a button never appears before the credentials exist. If it
is set first, the button renders and clicking it produces
"Google sign-in is not set up yet. Use your email and password." — civil, but a
control on a public auth page that does nothing. Do step 3, then step 4.

To offer only one provider, name only that one. To take a provider down in a
hurry, remove it from this list and redeploy — no Application change needed.

---

## 5. Check it

1. `https://rekey.dev/sign-in` shows "Continue with Google" and
   "Continue with Discord".
2. Clicking Google lands on `accounts.google.com`, not on an error page.
3. Completing consent returns you to `https://rekey.dev/account`, signed in.
4. `https://rekey.dev/api/auth/oauth/google/callback?code=x&state=y` pasted
   directly into the address bar redirects to
   `/sign-in?oauth_error=state` — that is the login-CSRF guard refusing a
   callback this browser did not start.

---

## What OAuth sign-in does NOT do

**It does not guarantee a verified email address.** This is worth being precise
about, because it changes whether the verification flow is still load-bearing.

`oauth.service.ts` creates a new EndUser with
`emailVerified: identity.emailVerified` — the provider's own claim, reflected
faithfully rather than forced to `true`. The refusals at `:210` and `:336` do
not close the gap:

- The `:210` check (`OAUTH_EMAIL_NOT_VERIFIED`) only fires when an account with
  that email **already exists** — it is an account-takeover guard on
  auto-linking, not a gate on sign-up.
- The `:336` check is in `linkIdentity`, the flow for an already-authenticated
  user adding a provider. It never runs on a first-time OAuth sign-in.

So a first-time OAuth sign-up whose provider does not assert a verified email
creates the account with `emailVerified: false`, and
`issueSessionOrMfaChallenge` → `ensureEmailVerified` then refuses the session
with 403 `EMAIL_NOT_VERIFIED` — **after** the row was written. That buyer now
has an account with no password and no session, and the verification link is
their only way in. rekey.dev handles it: the callback sends them to
`/verify?state=required`, which explains the situation and offers a resend.

In practice both providers we offer do assert it:

- **Google** sets `email_verified` in the id_token, and it is true for Gmail and
  Workspace accounts.
- **Discord** sets `verified` on the user object, true once the account has
  confirmed its email — which Discord requires for most of its functionality.

So the common case is that an OAuth buyer never sees the verification flow. But
"almost always" is not "always", and
`packages/shared-types/src/index.ts` currently claims more than the code does —
its `requireEmailVerification` docblock says OAuth sign-in "carries its own
proof of the address and marks it verified", which is true of magic-link and not
of OAuth. Treat the verification flow as required infrastructure, not as a
fallback that OAuth makes redundant.
