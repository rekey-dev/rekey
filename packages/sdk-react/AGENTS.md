# AGENTS.md — `@rekey.dev/react`

React hooks **plus drop-in UI components** (Clerk-shaped) for end-user auth, organizations and billing.

## When to use

The user wants browser-side knowledge of "is this user signed in" — to render `<SignedIn>` / `<SignedOut>` regions, show the user's email in a header, gate UI features — or wants working auth/billing UI without building forms.

**Do NOT use** for:
- Server-only auth (use `@rekey.dev/nextjs/server` `auth()`).
- Enforcing entitlements. `<Protect>` renders a decision; it does not make one. Anything that must actually hold goes through the customer's server.

You *can* hand-roll a form — `useUser()` + `RekeyBrowserClient` are the primitives — but reach for `<SignIn>` / `<SignUp>` first and theme them via `Appearance`.

## Surface

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
<RekeyProvider apiUrl publishableKey? initialUser? accessToken? meEndpoint?>{children}</RekeyProvider>
useUser()                       → { user, signedIn, loading }
useRekey()                      → { refresh }
<SignedIn> / <SignedOut> / <Loading> / <RekeyLoading> / <RekeyLoaded>
<Protect authorization={…}>     → renders a server-resolved entitlement/role decision
Auth widgets                    → SignIn, SignUp, UserButton, SignInButton, SignUpButton, SignOutButton
Org widgets                     → OrganizationSwitcher, CreateOrganization, OrganizationProfile
Billing widgets                 → PricingTable, CheckoutButton, ProviderPicker, PriceFallbackNotice, CouponQuote
Theming                         → Themed, useAppearance, Appearance
Backendless client              → RekeyBrowserClient (publishable key + user token)
mcpConnectionInfo()
```

## Auth model — important to internalise

The browser **never sees the Application secret key**. The flow is:

```
Browser → your customer's server → @rekey.dev/node → Rekey
                                                    ↓
                                returns { user, accessToken } via cookie
                                                    ↓
SSR seeds <RekeyProvider initialUser={user} accessToken={accessToken}>
```

The `accessToken` here is the **end-user's** JWT, *not* the Application secret. It's safe to expose to client JS for the duration of the user's session — but rotate it via cookie on the server.

The provider's `meEndpoint` defaults to `/api/v1/users/me/by-token`. The server-side Rekey API today requires both an Application secret and a user JWT for `/users/me` — so for the browser to call it directly, your customer's app needs a tiny passthrough route that adds the secret. Or pre-fetch `initialUser` server-side (the recommended pattern) and skip the round-trip.

## What NOT to do

- Don't ship the Application secret key to the browser. Ever. Even in a hidden field, even encoded.
- Don't use `useUser()` outside `<RekeyProvider>` — it throws explicitly.
- Don't add styled sign-in/sign-up components here. Headless on purpose. Customers style their own.
- Don't pre-render `<SignedIn>` content during SSR with `loading=true` — the helper returns null until the provider resolves, which is correct.
