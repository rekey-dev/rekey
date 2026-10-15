# `@rekey.dev/react`

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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
```tsx
<RekeyProvider
  apiUrl={process.env.NEXT_PUBLIC_REKEY_URL!}
  publishableKey="rp_pub_myapp-prod_…"   // safe in client code
>
  <App />
</RekeyProvider>
```

<!-- snippet: no-check a fragment: no imports, and values from the surrounding code -->
```ts
import { RekeyBrowserClient } from '@rekey.dev/react';

const client = new RekeyBrowserClient({ apiUrl, publishableKey: 'rp_pub_…' });
const out = await client.signIn({ email, password });   // → SignInOutcome (branch on mfaRequired)
const { items: plans, page } = await client.getPlans();  // public catalogue → {items, page}; render plan.price.formatted
const lic = await client.verifyLicense({ key, machineFingerprint });

// The signed-in user's own state, with their access token
const me = await client.getMe(accessToken, { include: ['entitlements', 'device'] }); // GET /auth/me
const { meters } = await client.getUsageRemaining(accessToken);
```

With the user's access token the browser client also reads what that user
may see about themselves: `getMe` (`include` any of `entitlements`, `device`,
`subscription`, `organization`, `licenses`), `getEntitlements`, `getFeature` /
`hasFeature`, `getSubscription`, `listMyLicenses`, `getUsageRemaining`,
`listMyCreditLedger`, `listMyDevices`, `getTrialEligibility` and `validateCoupon`
(a coupon quote at the price their checkout would charge). Each plan from
`getPlans` carries `checkout.ready` and `price`, the price this buyer would be
charged: render `price.formatted`. Pass `{ accessToken }` as the second argument
for a signed-in buyer.

Restrict where the key works via the Application's **CORS origin allowlist** (Panel → Application → Access); off-allowlist origins get `403 ORIGIN_NOT_ALLOWED`. Money + account-management routes still require the secret key on a server. See [api-keys.md → Publishable key](https://github.com/rekey-dev/rekey/blob/main/docs/api-keys.md#publishable-key).

### Hooks

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

`useOAuthProviders()` returns the Application's enabled OAuth providers (`[{ id, name }]`, or `null` until loaded) for a sign-in page you build yourself.

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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

**OAuth buttons without listing them.** Leave `oauthProviders` out and pass a start target, and the card shows every provider enabled on the Application in the panel (fetched with the publishable key, so set `publishableKey` on `<RekeyProvider>`):

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
```tsx
<SignIn action={signInAction} oauthStartAction={startOAuthAction} />       // action gets formData.get('provider')
<SignIn action={signInAction} oauthStartUrl="/oauth/{provider}/start" />   // {provider} is replaced
```

The buttons appear just after hydration. The list is fetched once per `<RekeyProvider>` and kept for the life of the page, so a provider enabled in the panel shows up after the next full page load. For the first paint, fetch on your server with `rekey.auth.listOAuthProviders()` from `@rekey.dev/node` and pass `oauthProviders`, which always wins. See [docs/react-components.md](../../docs/react-components.md#oauth-buttons-from-the-panel).

### `<UserButton>`

Avatar + dropdown menu (manage account, sessions, sign out). Renders nothing when signed out.

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
```tsx
<CreateOrganization action={createOrgAction} />
```

### `<OrganizationProfile>`

Members + pending invitations, with role-change / remove / revoke affordances for OWNER/ADMIN viewers.

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

Renders your plans with upgrade buttons. Plans come from `billing.getPlans()`, fetched **server-side** and passed in as they are; each upgrade posts to your checkout action.

Each plan carries `price`: the price this buyer would be charged, resolved by the API with the function checkout uses. The table renders `price.formatted` and does no arithmetic. So fetch the plans for the buyer in front of you: pass their `country`, and their access token when they are signed in.

> **`getPlans()` returns `{ items, page }`, not an array.** Pass `.items` to the component. `page.hasMore` is how you learn the catalogue is longer than the window you were served.

```tsx
// app/pricing/page.tsx (Server Component)
import { PricingTable } from '@rekey.dev/react';
import { auth, visitorCountryHint } from '@rekey.dev/nextjs/server';
import { rekey } from '@/lib/rekey';
import { checkout } from './actions';

export default async function Pricing() {
  const session = await auth();
  const scoped = rekey.with({ visitorCountryHint: await visitorCountryHint() });
  const { items } = await scoped.billing.getPlans(undefined, session ? { accessToken: session.accessToken } : {});

  return <PricingTable plans={items} checkoutAction={checkout} />;
}
```

- `PricingPlan` requires `price`, `prices`, `isFree` and `checkout`. It no longer has `amount` or `currency`. A plan built by hand supplies `price: { currency, amount, formatted }` and lists its one price in `prices`.
- The `currency` prop is removed: the price shown has to be the price charged.
- `priceFallbackNote` is what a card says when the plan's `price.reason` is `fallback` (the price selected for the buyer cannot be charged, and the default price is shown and charged). It defaults to a sentence naming the price.
- `unavailableLabel` is what a paid plan's card shows in place of its button when `checkout.ready` is false. Default "Not available right now".
- `currentPlanSlug`, `hiddenFields`, `orgGateBlocking`, `hideFreeCta` and `ctaLabel` are unchanged.

### `<PriceFallbackNotice>` and `<CouponQuote>`

Two small components for what a buyer is told about the price before they pay. Both render text the API wrote; neither computes an amount.

```tsx
'use client';
import { CouponQuote, PriceFallbackNotice } from '@rekey.dev/react';
import type { CheckoutResultDto, ValidateCouponResultDto } from '@rekey.dev/react';

export function BeforeYouPay({ checkout, quote }: { checkout: Pick<CheckoutResultDto, 'url' | 'priceFallback'>; quote: ValidateCouponResultDto | null }) {
  return (
    <div>
      {/* "Prices in INR are not available yet. You will pay $19.00." Renders nothing without a fallback. */}
      <PriceFallbackNotice fallback={checkout.priceFallback} />
      {/* "LAUNCH50 takes ₹750.00 off. You pay ₹749.00." */}
      {quote && <CouponQuote quote={quote} />}
      <a href={checkout.url}>Continue to payment</a>
    </div>
  );
}
```

`fallback` is `priceFallback` from `createCheckout()` or `validateCoupon()`. `quote` is what `validateCoupon()` resolved to. A refused code throws: show that error's `message`. For `COUPON_CURRENCY_NOT_COVERED` it says the code does not work for prices in the buyer's currency, and the buyer can continue without it.

`formatMoney`, `minorUnitExponent`, `validatePriceAmount`, `sellableCurrencies` and `priceFallbackMessage` are exported from this package too, for the few places a page formats an amount itself, such as `formatMoney(payment.amount - payment.refundedAmount, payment.currency)`.

### `<CheckoutButton>`

A single-plan CTA.

```tsx
import { CheckoutButton } from '@rekey.dev/react';
import { checkout } from './actions';

export function Upgrade() {
  return (
    <CheckoutButton planSlug="pro_monthly" action={checkout}>
      Upgrade to Pro
    </CheckoutButton>
  );
}
```

### `<ProviderPicker>`: let the user choose how to pay

An Application can enable more than one billing provider. Checkout's `provider` is optional: when you omit it, Rekey routes the checkout. `<ProviderPicker>` lets the end-user override that pick with a "Pay with…" radio group.

Like `<PricingTable plans>`, the provider list is a **prop**: the picker renders what you hand it and issues no API calls of its own. `GET /api/v1/billing/providers` sits at the same trust level as `/plans`. It accepts the **publishable key** as well as a secret key, so you can fetch it either server-side with `billing.getProviders()` or in the browser with `listBillingProviders()`.

```tsx
// Server component: fetch both lists with the secret key, pass them down.
import { PricingTable } from '@rekey.dev/react';
import { rekey } from '@/lib/rekey';
import { checkout } from './actions';

export default async function Pricing() {
  const { items } = await rekey.billing.getPlans(undefined, { country: 'IN' });
  const { providers, routedProvider } = await rekey.billing.getProviders('IN'); // country optional (ISO 3166-1 alpha-2)

  return <PricingTable plans={items} providers={providers} routedProvider={routedProvider} checkoutAction={checkout} />;
}
```

Each provider's `currencies` is what that account charges. An empty list means none: such a provider is never posted with a paid plan. Leave the field out when you have no list, and the provider is treated as able to charge. Pass the providers as `getProviders()` returned them.

With `providers` passed, `<PricingTable>` renders the picker above the grid. The chosen provider is posted as `provider` with a plan it can charge, and for a plan with more than one price only once the buyer has changed the picker. Your checkout Server Action must **forward it** to `createCheckout`:

```ts
// app/pricing/actions.ts
'use server';
import { redirect } from 'next/navigation';
import { auth } from '@rekey.dev/nextjs/server';
import { rekey } from '@/lib/rekey';

export async function checkout(formData: FormData) {
  const session = await auth();
  if (!session) redirect('/sign-in');
  const planSlug = String(formData.get('planSlug'));
  const provider = formData.get('provider'); // 'stripe' | 'paypal' | 'razorpay' | null
  const result = await rekey.billing.createCheckout(session.accessToken, {
    planSlug,
    successUrl,
    cancelUrl,
    ...(provider ? { provider: String(provider) } : {}), // left out, Rekey routes the checkout
  });
  // Set when the default price is charged because the selected one could not be.
  if (result.priceFallback) redirect(`/checkout/confirm?session=${result.checkoutSessionId}`);
  redirect(result.url);
}
```

> Without `providers`, `<PricingTable>` stays a Server Component (zero client JS). The provider-aware variant is an interactive client component, dispatched only when `providers` is non-empty.

Use it standalone (outside `<PricingTable>`) by dropping it into any checkout `<form>`. The selected radio posts `provider` with no JS in uncontrolled mode:

```tsx
import { ProviderPicker } from '@rekey.dev/react';
import type { ProviderOption } from '@rekey.dev/react';
import { checkout } from './actions';

export function PayWith({ providers }: { providers: ProviderOption[] }) {
  return (
    <form action={checkout}>
      <input type="hidden" name="planSlug" value="pro_monthly" />
      <ProviderPicker providers={providers} />
      <button type="submit">Continue</button>
    </form>
  );
}
```

It also supports a controlled `value` + `onChange` pair, an optional `label`, and a custom field `name`. `routedProvider` from the same response is selected by default; without it, the first provider in the list is.

### Org-billing (`billingSubject='org'`)

When your Application bills **per team** (Panel → Application → Billing → Setup → Settings, Who pays = Organizations), an individual can't hold a subscription — the user must be inside a team first, and the org id must ride along to checkout.

- `<OrganizationSwitcher billingSubject="org">` hides the personal option and nudges the user to select/create a team when none is active.
- `<PricingTable orgGateBlocking={...}>` renders a **"team required"** gate instead of dead upgrade buttons.
- Thread the active org into checkout with `hiddenFields={{ orgId }}` (your action passes it as `organizationId`, scoping the subscription to the team's shared pool).

Resolve `billingSubject` server-side from `rekey.applications.me().billingConfig.billingSubject`.

---

## List forms

`<NewsletterForm list="waitlist" />` and `<ContactForm list="contact" />` collect
people into a list (a waitlist, a newsletter, a contact form); `useListSubscribe`
is the hook under both. From the browser they need Public capture on the list;
pass `action` (your Server Action) and `form` (from `rekey.lists.get(key)` on your
server) to post through your server instead. Rekey sends no email to a list. See
[docs/react-components.md](https://github.com/rekey-dev/rekey/blob/main/docs/react-components.md#list-forms).

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
```tsx
<NewsletterForm list="waitlist" title="Join the waitlist" />
```

## Theming

Every component accepts an `appearance` prop and a `className`. Theming is **tokens-based** — a single stylesheet keyed on CSS custom properties (`--rekey-*`), injected once and scoped under `.rekey-root`, so it never leaks into your app and depends on no CSS framework.

### Light / dark

Defaults follow `prefers-color-scheme`. Pin it explicitly:

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
```tsx
<SignIn appearance="dark" action={signInAction} />
```

### Override tokens

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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

<!-- snippet: no-check a JSX fragment: no imports, and values from the surrounding page -->
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
For the components in a running app, see the
[quickstart](https://rekey.dev/docs/quickstart) (`<SignIn>` and `<SignUp>`
wired to Next.js server actions) and the
[nextjs-starter](https://github.com/rekey-dev/nextjs-starter) repository.

## Headless escape hatch

Need full control? Skip the components and use `useUser()` + the control primitives, or talk to the API directly with `RekeyBrowserClient` — the same publishable-key client the components use, so it covers the bootstrap writes (`signUp`, `signIn`, `mfaVerify`, `createCheckout`, `cancelSubscription`) as well as reads. It is publishable-key-scoped, not read-only: anything acting on a specific user still needs that user's access token.

---

## About Rekey

Rekey is a self-hostable **auth + billing backend for SaaS** — one API for sign-in, subscriptions, usage, credits, licenses, and teams.

- Website + docs: **[rekey.dev](https://rekey.dev)** · [rekey.dev/docs](https://rekey.dev/docs)
- Other SDKs: [`@rekey.dev/node`](https://www.npmjs.com/package/@rekey.dev/node) (server) · [`@rekey.dev/nextjs`](https://www.npmjs.com/package/@rekey.dev/nextjs) (Next.js) · [`@rekey.dev/cli`](https://www.npmjs.com/package/@rekey.dev/cli) · [`@rekey.dev/mcp`](https://www.npmjs.com/package/@rekey.dev/mcp) (MCP server)

## License

MIT
