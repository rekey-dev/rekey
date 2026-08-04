# `@rekey.dev/react`

> **ReliPay is now Rekey.** This package was previously published as the equivalent `@relipay/*` package, which is deprecated. Env vars renamed `RELIPAY_*` → `REKEY_*` (as of 2.0.0 the old names are no longer read — set `REKEY_*`). relipay.dev (the old domain) will redirect to rekey.dev after the domain migration.

The browser SDK for **[Rekey](https://rekey.dev)** — React hooks **and drop-in UI components** for end-user auth, organizations, and billing.

> **What is Rekey?** An auth + billing backend for your SaaS: sign-in (password, magic-link, passkeys, OAuth, MFA), subscriptions, usage, credits, licenses, and teams — behind one API, multi-tenant, provider-agnostic. Docs: **[rekey.dev/docs](https://rekey.dev/docs)**. This package is its React/browser SDK; the server SDK is [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node).

It gives you drop-in components (`<SignIn>`, `<UserButton>`, `<PricingTable>`, …) plus the headless primitives (`useUser`, `<SignedIn>`, `<Protect>`) so you can ship auth/billing UI fast, or build your own.

```bash
npm install @rekey.dev/react
# or: pnpm add @rekey.dev/react   /   yarn add @rekey.dev/react
```

> Peer dependency: `react@^18 || ^19`. No CSS framework required — the components ship their own tokens-based stylesheet.

---

## The security model (read this first)

The browser **never holds your Application secret key** (`rp_live_…` / `rp_test_…`). The only credentials it may hold are the end-user's short-lived JWT (the access token) and — optionally, for backendless mode — the Application's **publishable** key (`rp_pub_…`), which is public by design and grants nothing on its own.

Because of that, the components here are **render + delegate**:

- They **read** auth state from `<RekeyProvider>` (which calls the user-token-only `GET /api/v1/auth/me`).
- For **writes** — sign-in, sign-up, sign-out, create-org, invite, checkout — they call **your** server (a Next.js Server Action or a route handler) that runs [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) with the secret key. The secret key never reaches the browser — the components talk to your server, and your server is the only thing that talks to Rekey with it.

```
Browser (UI components, public)
   │  form submit / Server Action
   ▼
Your server  ──@rekey.dev/node + secret──►  Rekey API
   │  sets the session cookie
   ▼
SSR seeds <RekeyProvider> on the next render
```

So every component below that mutates something takes an `action` (or `actionUrl`) prop — that's your server code.

---

## Setup: `<RekeyProvider>`

Wrap your app once, seeded from your server session. With Next.js + [`@rekey.dev/nextjs`](https://www.npmjs.com/package/@rekey.dev/nextjs):

```tsx
// app/layout.tsx (Server Component)
import { auth } from '@rekey.dev/nextjs/server';
import { RekeyProvider } from '@rekey.dev/react';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth(); // { user, accessToken } | null
  return (
    <html>
      <body>
        <RekeyProvider
          apiUrl={process.env.NEXT_PUBLIC_REKEY_URL!}
          initialUser={session?.user ?? null}
          accessToken={session?.accessToken ?? null}
        >
          {children}
        </RekeyProvider>
      </body>
    </html>
  );
}
```

`apiUrl` is your Rekey deployment's base URL — **not a secret**. The `accessToken` is the end-user's JWT (safe to expose to client JS for the session; rotate it via cookie on the server).

> **Publishable key vs secret key.** Your Application's publishable key (`rp_pub_…`) is a **real browser credential** — safe to ship in client code. The secret key (`rp_live_…` / `rp_test_…`) is server-only. There are two ways to drive auth from this SDK:
>
> 1. **Server-delegated (this README's prebuilt components).** Writes go to your Server Actions running [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) with the secret key; the browser only reads auth state via the user JWT. Best when you already have a server.
> 2. **Backendless.** Pass `publishableKey` to `<RekeyProvider>` and call the client's bootstrap methods (`client.signIn`, `signUp`, `requestMagicLink`, `verifyLicense`, `getPlans`) straight from the browser — no server required. The publishable key only identifies the app; the user still proves identity (password/passkey/token). See [Backendless mode](#backendless-mode).

## Backendless mode

For a pure SPA / mobile / desktop app with no backend, give the provider a `publishableKey` and call the bootstrap methods directly:

```tsx
<RekeyProvider
  apiUrl={process.env.NEXT_PUBLIC_REKEY_URL!}
  publishableKey="rp_pub_myapp-prod_…"   // safe in client code
>
  <App />
</RekeyProvider>
```

```ts
import { RekeyBrowserClient } from '@rekey.dev/react';

const client = new RekeyBrowserClient({ apiUrl, publishableKey: 'rp_pub_…' });
const out = await client.signIn({ email, password });   // → SignInOutcome (branch on mfaRequired)
const { items: plans, page } = await client.getPlans();  // public catalogue → {items, page}
const lic = await client.verifyLicense({ key, machineFingerprint });
```

Restrict where the key works via the Application's **CORS origin allowlist** (Panel → Application → Access); off-allowlist origins get `403 ORIGIN_NOT_ALLOWED`. Money + account-management routes still require the secret key on a server. See [api-keys.md → Publishable key](https://github.com/rekey-dev/rekey/blob/main/docs/api-keys.md#publishable-key).

### Hooks

```tsx
'use client';
import { useUser, useRekey } from '@rekey.dev/react';

function Profile() {
  const { user, signedIn, loading } = useUser();
  const { refresh } = useRekey(); // re-fetch the user after a sign-in round-trip
  if (loading) return <Spinner />;
  if (!signedIn) return <a href="/login">Sign in</a>;
  return <p>Hi {user.email}</p>;
}
```

---

## Control components

Gate regions of your UI. No styling, no opinions.

| Component | Renders children when… |
| --- | --- |
| `<SignedIn>` | a user is signed in |
| `<SignedOut>` | no user is signed in |
| `<RekeyLoading>` | the provider is still resolving the session |
| `<RekeyLoaded>` | the provider has resolved |
| `<Protect>` | the supplied entitlement / feature / role check passes |

```tsx
import { SignedIn, SignedOut, RekeyLoading, RekeyLoaded, Protect } from '@rekey.dev/react';

<RekeyLoading><Spinner /></RekeyLoading>
<RekeyLoaded>
  <SignedIn><Dashboard /></SignedIn>
  <SignedOut><Landing /></SignedOut>
</RekeyLoaded>
```

### `<Protect>` — gate by entitlement / feature / role

Entitlements **resolve server-side** (`@rekey.dev/node` `billing.getEntitlements`) — the browser never re-fetches them with a credential. Pass the resolved facts in via `authorization`; `<Protect>` renders the decision your server already made.

```tsx
// feature flag
<Protect authorization={{ features }} feature="analytics" fallback={<UpgradeCard />}>
  <AnalyticsTab />
</Protect>

// role (in the active org)
<Protect authorization={{ role }} role={['OWNER', 'ADMIN']}>
  <InviteMembersButton />
</Protect>

// numeric limit, via a predicate
<Protect authorization={{ features }} condition={(a) => Number(a.features?.max_qr_codes) >= 10}>
  <BulkTools />
</Protect>
```

---

## Auth widgets

### `<SignIn>` / `<SignUp>`

Styled cards with email + password, optional magic-link, and optional OAuth buttons. They **post to your Server Actions**.

```tsx
'use client';
import { SignIn } from '@rekey.dev/react';
import { signInAction, magicLinkAction, startGoogle } from '@/lib/actions';

<SignIn
  action={signInAction}            // (formData) => server-side rekey.auth.signIn(...)
  magicLinkAction={magicLinkAction}
  oauthProviders={[{ provider: 'google', startAction: startGoogle }]}
  signUpUrl="/signup"
  forgotPasswordUrl="/forgot-password"
/>

<SignUp action={signUpAction} signInUrl="/login" />
```

A matching server action looks like (Next.js App Router):

```ts
// lib/actions.ts
'use server';
import { signIn } from '@rekey.dev/nextjs/server';
import { redirect } from 'next/navigation';

export async function signInAction(formData: FormData) {
  const email = String(formData.get('email'));
  const password = String(formData.get('password'));
  await signIn({ email, password }); // sets the session cookie
  redirect('/dashboard');
}
```

Not on the App Router? Use `actionUrl="/api/sign-in"` (the form does a plain `POST`) and call `useRekey().refresh()` after.

### `<UserButton>`

Avatar + dropdown menu (manage account, sessions, sign out). Renders nothing when signed out.

```tsx
<UserButton
  manageAccountUrl="/account"
  sessionsUrl="/account#sessions"
  signOutAction={signOutAction}
  extraItems={[{ label: 'Billing', href: '/billing' }]}
/>
```

### `<SignInButton>` / `<SignUpButton>` / `<SignOutButton>`

Small affordances. Sign-in/up navigate to a URL; sign-out invokes your action.

```tsx
<SignedOut>
  <SignInButton url="/login" />
  <SignUpButton url="/signup" />
</SignedOut>
<SignedIn>
  <SignOutButton action={signOutAction} />
</SignedIn>
```

---

## Organization widgets

The org endpoints are secret-key guarded, so these read **server-resolved data via props** and delegate mutations to your actions.

### `<OrganizationSwitcher>`

Pick / switch / create the active team.

```tsx
<OrganizationSwitcher
  organizations={orgs}              // organizations.listMine().items, server-side
  activeOrganizationId={activeOrgId}
  switchAction={switchOrgAction}    // organizations.switch() + cookie rotation
  createAction={createOrgAction}
  billingSubject={config.billingSubject}  // see org-billing note below
/>
```

### `<CreateOrganization>`

```tsx
<CreateOrganization action={createOrgAction} />
```

### `<OrganizationProfile>`

Members + pending invitations, with role-change / remove / revoke affordances for OWNER/ADMIN viewers.

```tsx
<OrganizationProfile
  organization={{ id: org.id, name: org.name }}
  members={members}                 // organizations.listMembers().items, server-side
  invitations={pendingInvites}      // optional
  viewerRole={myRole}               // gates the manage affordances
  inviteAction={inviteMemberAction}
  setRoleAction={setRoleAction}
  removeAction={removeMemberAction}
  hiddenFields={{ orgId: org.id }}  // appended to every form
/>
```

> Form field contract: invite reads `email` + `role`; set-role/remove read `endUserId`; revoke reads `invitationId`. Add the org id with `hiddenFields`.

> **`members` needs both ids.** `OrganizationMemberDto` carries `id` (the membership row) *and* `endUserId` (the user); the mutation endpoints address the latter. Pass `organizations.listMembers().items` straight through and you get both. If you build the array by hand, include `endUserId` — before 2.0.0-rc.3 the component posted `id` there, so role changes and removals silently did nothing.

---

## Billing widgets

### `<PricingTable>`

Renders your plans with upgrade buttons. Plans come from `billing.getPlans()` (public — no user token needed) fetched **server-side** and passed in; each upgrade posts to your checkout action.

> **`getPlans()` returns `{ items, page }`, not an array** (2.0.0-rc.3 — every list method does). Pass `.items` to the component. `page.hasMore` is worth reading on a pricing page: it is how you learn the catalogue is longer than the window you were served.

```tsx
<PricingTable
  plans={plans}                       // billing.getPlans().items, server-side
  currentPlanSlug={isPro ? 'pro_monthly' : 'free'}
  checkoutAction={checkoutAction}     // billing.createCheckout() + redirect
  hiddenFields={activeOrgId ? { orgId: activeOrgId } : undefined}
  orgGateBlocking={config.billingSubject === 'org' && !activeOrgId}
/>
```

### `<CheckoutButton>`

A single-plan CTA.

```tsx
<CheckoutButton planSlug="pro_monthly" action={checkoutAction}>
  Upgrade to Pro
</CheckoutButton>
```

### `<ProviderPicker>` — let the user choose how to pay

An Application can enable up to **3 billing providers** (`stripe` / `paypal` / `razorpay`). Checkout's `provider` is optional — when you omit it, a **server-side geo router** auto-picks one. `<ProviderPicker>` lets the end-user override that pick with a "Pay with…" radio group.

Like `<PricingTable plans>`, the provider list is a **prop**: the picker renders what you hand it and issues no API calls of its own. `GET /api/v1/billing/providers` sits at the same trust level as `/plans` — it accepts the **publishable key** as well as a secret key — so you can fetch it either server-side with `billing.getProviders()` or in the browser with `listBillingProviders()`.

```tsx
// Server component — fetch the list with the secret key, pass it down.
const { providers } = await rekey.billing.getProviders(country); // country optional (ISO-3166 alpha-2)

<PricingTable
  plans={plans}                       // billing.getPlans().items, server-side
  providers={providers}               // billing.getProviders() server-side
  checkoutAction={checkoutAction}
/>
```

With `providers` passed, `<PricingTable>` renders the picker above the grid and threads the chosen provider into **every** plan's checkout form (posted as `provider`). Your checkout Server Action must **forward it** to `createCheckout`:

```ts
// lib/actions.ts
'use server';
export async function checkoutAction(formData: FormData) {
  const planSlug = String(formData.get('planSlug'));
  const provider = formData.get('provider'); // 'stripe' | 'paypal' | 'razorpay' | null
  const { url } = await rekey.billing.createCheckout(session.accessToken, {
    planSlug,
    successUrl, cancelUrl,
    ...(provider ? { provider: provider as BillingProvider } : {}), // omit → geo router picks
  });
  redirect(url);
}
```

> Without `providers`, `<PricingTable>` stays a Server Component (zero client JS). The provider-aware variant is an interactive client component, dispatched only when `providers` is non-empty.

Use it standalone (outside `<PricingTable>`) by dropping it into any checkout `<form>` — the selected radio posts `provider` with no JS in uncontrolled mode:

```tsx
<form action={checkoutAction}>
  <input type="hidden" name="planSlug" value="pro_monthly" />
  <ProviderPicker providers={providers} />
  <button type="submit">Continue</button>
</form>
```

It also supports a controlled `value` + `onChange` pair, an optional `label`, and a custom field `name`. The first provider in the list (the geo router's top pick) is selected by default.

### Org-billing (`billingSubject='org'`)

When your Application bills **per team** (Panel → Application → Billing → Subject = `org`), an individual can't hold a subscription — the user must be inside a team first, and the org id must ride along to checkout.

- `<OrganizationSwitcher billingSubject="org">` hides the personal option and nudges the user to select/create a team when none is active.
- `<PricingTable orgGateBlocking={...}>` renders a **"team required"** gate instead of dead upgrade buttons.
- Thread the active org into checkout with `hiddenFields={{ orgId }}` (your action passes it as `organizationId`, scoping the subscription to the team's shared pool).

Resolve `billingSubject` server-side from `rekey.applications.me().billingConfig.billingSubject`.

---

## Theming

Every component accepts an `appearance` prop and a `className`. Theming is **tokens-based** — a single stylesheet keyed on CSS custom properties (`--rekey-*`), injected once and scoped under `.rekey-root`, so it never leaks into your app and depends on no CSS framework.

### Light / dark

Defaults follow `prefers-color-scheme`. Pin it explicitly:

```tsx
<SignIn appearance="dark" action={signInAction} />
```

### Override tokens

```tsx
<SignIn
  appearance={{
    baseTheme: 'light',
    variables: {
      colorPrimary: '#6d28d9',   // brand purple
      colorBackground: '#faf5ff',
      borderRadius: '8px',
      fontFamily: 'Inter, sans-serif',
    },
  }}
  action={signInAction}
/>
```

| Variable | What it controls |
| --- | --- |
| `colorPrimary` / `colorPrimaryText` | brand colour + button label colour |
| `colorBackground` / `colorSurface` | page / card backgrounds |
| `colorText` / `colorTextMuted` | text colours |
| `colorBorder` | borders + dividers |
| `colorDanger` | destructive actions, errors |
| `borderRadius`, `fontFamily`, `fontSize`, `spacing` | shape + typography |

You can also set the `--rekey-*` variables in your own CSS for app-wide theming.

### Per-element classes

Target one slot without re-theming (the `appearance.elements` pattern):

```tsx
<SignIn
  appearance={{ elements: { buttonPrimary: 'my-cta', card: 'shadow-2xl' } }}
  action={signInAction}
/>
```

Slots: `root`, `card`, `header`, `title`, `subtitle`, `label`, `input`, `button`, `buttonPrimary`, `buttonSecondary`, `buttonDanger`, `divider`, `footer`, `avatar`, `menu`, `menuItem`, `badge`, `alert`, `planCard`, `price`.

---

## Full reference

Every component's props, defaults and a working example per component:
[docs/react-components.md](https://github.com/rekey-dev/rekey/blob/main/docs/react-components.md).
(The `examples/` apps that used to live here were removed pending a rebuilt
set — the reference is checked against the source instead.)

## Headless escape hatch

Need full control? Skip the components and use `useUser()` + the control primitives, or talk to the API directly with `RekeyBrowserClient` — the same publishable-key client the components use, so it covers the bootstrap writes (`signUp`, `signIn`, `mfaVerify`, `createCheckout`, `cancelSubscription`) as well as reads. It is publishable-key-scoped, not read-only: anything acting on a specific user still needs that user's access token.

---

## About Rekey

Rekey is a self-hostable **auth + billing backend for SaaS** — one API for sign-in, subscriptions, usage, credits, licenses, and teams.

- Website + docs: **[rekey.dev](https://rekey.dev)** · [rekey.dev/docs](https://rekey.dev/docs)
- Other SDKs: [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) (server) · [`@rekey.dev/nextjs`](https://www.npmjs.com/package/@rekey.dev/nextjs) (Next.js) · [`@rekey.dev/cli`](https://www.npmjs.com/package/@rekey.dev/cli) · [`@rekey.dev/mcp`](https://www.npmjs.com/package/@rekey.dev/mcp) (MCP server)

## License

MIT
