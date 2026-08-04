# React components (`@rekey.dev/react`)

`@rekey.dev/react` ships hooks, control primitives, and a set of drop-in UI
components for sign-in, teams and billing. This page is the reference: what
each component takes, what it renders, and a working example per component.

```bash
pnpm add @rekey.dev/react     # peer: react@^18 || ^19
```

No CSS framework is required. The package injects one stylesheet, once per
document, scoped under `.rekey-root` and keyed on `--rekey-*` custom
properties — see [Theming](#theming).

## The one rule that shapes every component

**The browser never holds your Application secret key.** It may hold the
end-user's short-lived access token, and optionally the Application's
publishable key (`rp_pub_…`), which is public by design.

So every component here is *render + delegate*:

- **Reads** come from `<RekeyProvider>` (which calls the user-token-only
  `GET /api/v1/auth/me`), or from props you resolved on your server.
- **Writes** — sign-in, sign-up, create-org, invite, checkout — go to *your*
  server as a Next.js Server Action or a form POST. Your server runs
  `@rekey.dev/node` with the secret key and rotates the session cookie.

That is why the mutating components take an `action` prop rather than
credentials. Two integration styles, and every component accepts both:

| Prop shape | Use when |
|---|---|
| `action={serverAction}` | Next.js App Router. Wired to `<form action={…}>`; progressive-enhancement friendly, the action does the redirect. |
| `actionUrl="/api/sign-in"` | Anything else. The form does a plain `POST` to your route handler. |

There is also a backendless path for apps with no server at all — see
[Backendless mode](#backendless-mode).

---

## `<RekeyProvider>`

Wrap the app once, seeded from your server session.

| Prop | Type | Default | What |
|---|---|---|---|
| `apiUrl` | `string` | **required** | Base URL of your Rekey deployment. Not a secret. |
| `publishableKey` | `string` | — | `rp_pub_…`. Required only for [backendless mode](#backendless-mode). |
| `initialUser` | `EndUserDto \| null` | `null` | Pre-fetched user, so the first render needs no fetch. |
| `accessToken` | `string \| null` | `null` | The end-user's access token. The provider re-fetches when it changes. |
| `meEndpoint` | `string` | `/api/v1/auth/me` | Override only if you front Rekey with your own passthrough. |

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

Pass no `accessToken` and the provider resolves to signed-out without a
network call. Pass one with no `initialUser` and it fetches on mount.

## Hooks

```tsx
'use client';
import { useUser, useRekey } from '@rekey.dev/react';

function Profile() {
  const { user, signedIn, loading } = useUser();
  const { refresh } = useRekey();

  if (loading) return <Spinner />;
  // Narrow on `user`, not on `signedIn` — the boolean is a sibling field and
  // does not narrow the union for TypeScript.
  if (!user) return <a href="/sign-in">Sign in</a>;
  return <p>Hi {user.email}</p>;
}
```

`useUser()` → `{ user, signedIn, loading }`. `useRekey()` → `{ refresh }`, a
manual re-fetch for after a sign-in round-trip your server handled.

Both throw if called outside `<RekeyProvider>`, with a message that says so.

---

## Control components

Gate a region of UI. No styling, no markup of their own.

| Component | Renders `children` when |
|---|---|
| `<SignedIn>` | a user is signed in (nothing while loading) |
| `<SignedOut>` | no user is signed in (nothing while loading) |
| `<RekeyLoading>` | the provider is still resolving the session |
| `<RekeyLoaded>` | the provider has resolved, either way |
| `<Protect>` | the supplied entitlement / feature / role check passes |

```tsx
import { SignedIn, SignedOut, RekeyLoading, RekeyLoaded } from '@rekey.dev/react';

<RekeyLoading><Spinner /></RekeyLoading>
<RekeyLoaded>
  <SignedIn><Dashboard /></SignedIn>
  <SignedOut><Landing /></SignedOut>
</RekeyLoaded>
```

### `<Protect>`

| Prop | Type | Default | What |
|---|---|---|---|
| `authorization` | `{ features?, role? }` | `{}` | The resolved facts. **Omitted means every feature/role check fails** — it is fail-closed on purpose. |
| `feature` | `string` | — | Require `authorization.features[feature]` to be truthy. |
| `role` | `string \| string[]` | — | Require `authorization.role` to match one of these. |
| `condition` | `(auth) => boolean` | — | Arbitrary predicate — numeric limits, compound checks. |
| `children` | `ReactNode` | **required** | Rendered when signed in **and** every supplied check passes. |
| `fallback` | `ReactNode` | `null` | Rendered otherwise. |

`<Protect>` does not fetch entitlements. It could — `/billing/entitlements`
accepts the publishable key plus the user's own token — but a UI gate should
render a decision, not make one. Resolve entitlements on your server with
`billing.getEntitlements()` and pass them down. Whatever this component hides
is still reachable by anyone who edits the DOM, so the *enforcing* check has to
live on your server regardless.

```tsx
// Feature flag
<Protect authorization={{ features }} feature="analytics" fallback={<UpgradeCard />}>
  <AnalyticsTab />
</Protect>

// Role in the active organization
<Protect authorization={{ role }} role={['OWNER', 'ADMIN']}>
  <InviteMembersButton />
</Protect>

// Numeric limit
<Protect authorization={{ features }} condition={(a) => Number(a.features?.max_seats) >= 10}>
  <BulkTools />
</Protect>
```

---

## Auth widgets

### `<SignIn>`

A card with email + password, optional magic-link row, optional OAuth buttons.

| Prop | Type | Default | What |
|---|---|---|---|
| `action` / `actionUrl` | `FormAction` / `string` | — | Where the password form goes. Reads `email` + `password` from `FormData`. |
| `magicLinkAction` / `magicLinkUrl` | `FormAction` / `string` | — | Renders the magic-link row when set. Reads `email`. |
| `oauthProviders` | `OAuthProvider[]` | `[]` | One button each. `{ provider, label?, startAction?, startUrl? }`; the label defaults to `Continue with <Provider>`. |
| `signUpUrl` | `string` | — | "Create account" link. Omit to hide. |
| `forgotPasswordUrl` | `string` | — | "Forgot password?" link. Omit to hide. |
| `error` | `ReactNode` | — | Rendered in an `role="alert"` banner — map it from your `?error=` param. |
| `title` | `string` | `Sign in` | Heading. |
| `subtitle` | `string` | — | Optional sub-heading. |
| `appearance` | `AppearanceProp` | — | See [Theming](#theming). |
| `className` | `string` | — | Applied to the themed root. |

```tsx
'use client';
import { SignIn } from '@rekey.dev/react';
import { signInAction, magicLinkAction, startGoogle } from '@/lib/actions';

export default function Page({ searchParams }: { searchParams: { error?: string } }) {
  return (
    <SignIn
      action={signInAction}
      magicLinkAction={magicLinkAction}
      oauthProviders={[{ provider: 'google', startAction: startGoogle }]}
      signUpUrl="/signup"
      forgotPasswordUrl="/forgot-password"
      error={searchParams.error === 'bad_credentials' ? 'Email or password is incorrect.' : undefined}
    />
  );
}
```

The matching action:

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

`signIn` can return an MFA challenge rather than a session. The server helper
returns a `SignInOutcome`, a union discriminated on **`kind`** — branch on that
before you redirect:

```ts
const outcome = await signIn({ email, password });
if (outcome.kind === 'mfa_required') {
  // No cookies were set — `mfaChallengeToken` is not a session.
  return redirect(`/mfa?challenge=${outcome.mfaChallengeToken}`);
}
// outcome.kind === 'session'
```

(The **browser** client's `signIn` is a different shape: it returns
`SignInOutcomeDto`, which uses a boolean `mfaRequired` field. Don't mix the two.)
See [auth.md](auth.md).

### `<SignUp>`

Same shape as `<SignIn>`, minus the magic-link row.

| Prop | Type | Default |
|---|---|---|
| `action` / `actionUrl` | `FormAction` / `string` | — |
| `oauthProviders` | `OAuthProvider[]` | `[]` |
| `signInUrl` | `string` | — ("Already have an account?" link) |
| `error` | `ReactNode` | — |
| `title` | `string` | `Create your account` |
| `subtitle`, `appearance`, `className` | | — |

```tsx
<SignUp action={signUpAction} signInUrl="/login" />
```

### `<UserButton>`

Avatar (the email's first letter) plus a dropdown. Renders **nothing** when
signed out or still loading, so it is safe to drop straight into a header.

| Prop | Type | What |
|---|---|---|
| `signOutAction` / `signOutUrl` | `FormAction` / `string` | The "Sign out" item. |
| `manageAccountUrl` | `string` | "Manage account" item. Omit to hide. |
| `sessionsUrl` | `string` | "Sessions & devices" item. Omit to hide. |
| `extraItems` | `Array<{ label, href?, onClick? }>` | Extra items, above sign-out. |
| `appearance`, `className` | | |

```tsx
<UserButton
  manageAccountUrl="/account"
  sessionsUrl="/account#sessions"
  signOutAction={signOutAction}
  extraItems={[{ label: 'Billing', href: '/billing' }]}
/>
```

The menu closes on outside click and carries `role="menu"` / `aria-haspopup`.

### `<SignInButton>` / `<SignUpButton>` / `<SignOutButton>`

Small affordances sharing one prop shape: `url` (renders an `<a>`), or
`action` (renders a one-button `<form>`), plus `children` to replace the
label, `variant` (`primary` | `secondary` | `danger`), `appearance`,
`className`. Defaults: sign-in `primary`, sign-up and sign-out `secondary`.

```tsx
<SignedOut>
  <SignInButton url="/login" />
  <SignUpButton url="/signup" />
</SignedOut>
<SignedIn>
  <SignOutButton action={signOutAction}>Log out</SignOutButton>
</SignedIn>
```

---

## Organization widgets

Reads come in as props you resolved server-side with `@rekey.dev/node`
(`organizations.listMine`, `organizations.listMembers`); writes are your
actions.

Both list methods resolve to `{ items, page }`, so pass `.items` to the
component and use `page.total` / `page.hasMore` if you render a count or a
pager: `const { items: orgs, page } = await rekey.organizations.listMine(token)`.

### `<OrganizationSwitcher>`

| Prop | Type | Default | What |
|---|---|---|---|
| `organizations` | `OrgSummary[]` | **required** | `{ id, name, role? }`. From `organizations.listMine()` — pass its `.items`. |
| `activeOrganizationId` | `string \| null` | `null` | The current active org. |
| `switchAction` | `FormAction` | **required** | Receives `orgId` (empty string = back to personal). |
| `createAction` | `FormAction` | — | Reads `name`. Enables the "Create team" affordance. |
| `billingSubject` | `'user' \| 'org'` | `'user'` | `'org'` surfaces the "select a team to continue" nudge. |
| `allowPersonal` | `boolean` | `true` | Ignored when `billingSubject === 'org'`. |
| `label` | `string` | `Workspace` | Heading. |

```tsx
<OrganizationSwitcher
  organizations={orgs}
  activeOrganizationId={activeOrgId}
  switchAction={switchOrgAction}
  createAction={createOrgAction}
  billingSubject={billingConfig.billingSubject}
/>
```

`organizations.switch()` returns a **fresh token pair** — your action must
persist both, or later reads use the stale org view.

When the app bills per team and the user has no teams yet, the switcher drops
the switch form entirely rather than rendering a control that would post an
empty `orgId` (which org-billing forbids) and steers them to "Create team".

### `<CreateOrganization>`

| Prop | Type | Default |
|---|---|---|
| `action` | `FormAction` | **required** (reads `name`, and `slug` when `withSlug`) |
| `withSlug` | `boolean` | `false` |
| `error` | `ReactNode` | — |
| `title` | `string` | `Create a team` |

```tsx
<CreateOrganization action={createOrgAction} error={nameTaken ? 'That name is taken.' : undefined} />
```

### `<OrganizationProfile>`

Members list plus pending invitations, with manage affordances that render
only when `viewerRole` is `OWNER` or `ADMIN`.

| Prop | Type | What |
|---|---|---|
| `organization` | `OrgSummary` | **Required.** The org being managed. |
| `members` | `OrgMember[]` | **Required.** `{ id, endUserId, email, role }` — **both** ids. `id` keys the row; `endUserId` is what `setRoleAction` / `removeAction` post, so omitting it ships forms that submit `undefined`. From `organizations.listMembers()` (pass its `.items`), which returns both. |
| `invitations` | `OrgInvitation[]` | Optional pending invites. |
| `viewerRole` | `string` | Gates the manage affordances. |
| `inviteAction` | `FormAction` | Reads `email` + `role`. |
| `setRoleAction` | `FormAction` | Reads `endUserId` + `role`. |
| `removeAction` | `FormAction` | Reads `endUserId`. |
| `revokeInviteAction` | `FormAction` | Reads `invitationId`. |
| `hiddenFields` | `Record<string, string>` | Appended to every form — this is where the org id goes. |
| `title` | `string` | Defaults to `<org name> · Members`. |

```tsx
<OrganizationProfile
  organization={{ id: org.id, name: org.name }}
  members={members} // [{ id, endUserId, email, role }, …]
  invitations={pendingInvites}
  viewerRole={myRole}
  inviteAction={inviteMemberAction}
  setRoleAction={setRoleAction}
  removeAction={removeMemberAction}
  revokeInviteAction={revokeInviteAction}
  hiddenFields={{ orgId: org.id }}
/>
```

The role selects offer `MEMBER` / `ADMIN` / `OWNER`; invites default to
`MEMBER`. The last-OWNER guard lives in the API, not here — your action will
get an error back if someone tries to demote or remove the final owner.

---

## Billing widgets

### `<PricingTable>`

| Prop | Type | Default | What |
|---|---|---|---|
| `plans` | `PricingPlan[]` | **required** | From `billing.getPlans()` — pass its `.items`. `amount` is an integer in minor units. |
| `checkoutAction` | `FormAction` | **required** | Reads `planSlug` (+ `provider` when a picker is shown). |
| `currentPlanSlug` | `string \| null` | `null` | Marks that plan "Current" and disables its button. |
| `hiddenFields` | `Record<string, string>` | — | Appended to every checkout form. |
| `orgGateBlocking` | `boolean` | `false` | Renders a "team required" gate instead of the grid. |
| `orgGate` | `ReactNode` | built-in notice | What that gate renders. |
| `hideFreeCta` | `boolean` | `true` | Free (`amount: 0`) plans have no checkout, so their CTA is hidden. |
| `ctaLabel` | `string` | `Choose` | CREDIT-kind plans say `Buy` regardless. |
| `providers` | `ProviderOption[]` | — | Adds a `<ProviderPicker>` above the grid. **Makes the table a client component**; without it, it stays a Server Component with no client JS. |

```tsx
// app/pricing/page.tsx — Server Component
// getPlans() resolves to `{items, page}`; `page.hasMore` tells you whether the
// catalogue is longer than the window you were served.
const { items: plans } = await rekey.billing.getPlans();

<PricingTable
  plans={plans}
  currentPlanSlug={sub?.plan.slug ?? null}
  checkoutAction={checkoutAction}
  hiddenFields={activeOrgId ? { orgId: activeOrgId } : undefined}
  orgGateBlocking={billingConfig.billingSubject === 'org' && !activeOrgId}
/>
```

### `<CheckoutButton>`

A single-plan CTA, for pages that aren't a full pricing grid.

| Prop | Type | Default |
|---|---|---|
| `planSlug` | `string` | **required** (posted as `planSlug`) |
| `action` | `FormAction` | **required** |
| `hiddenFields` | `Record<string, string>` | — |
| `variant` | `'primary' \| 'secondary'` | `primary` |
| `block` | `boolean` | `false` (full width when `true`) |
| `disabled` | `boolean` | `false` |

```tsx
<CheckoutButton planSlug="pro_monthly" action={checkoutAction}>
  Upgrade to Pro
</CheckoutButton>
```

### `<ProviderPicker>`

An Application can enable more than one billing provider. `createCheckout`'s
`provider` is optional — omit it and a server-side geo router picks. This
component lets the end-user override that with a "Pay with…" radio group.

| Prop | Type | Default | What |
|---|---|---|---|
| `providers` | `ProviderOption[]` | **required** | `{ provider, label?, priority?, countries? }`. The first entry is the router's top pick. |
| `name` | `string` | `provider` | Form field name — matches `createCheckout`'s `provider`. |
| `defaultValue` | `BillingProvider` | first entry | Uncontrolled initial selection. |
| `value` + `onChange` | | — | Controlled mode. |
| `label` | `ReactNode` | `Pay with` | Pass `null` to omit the heading. |

The list comes from `GET /api/v1/billing/providers`, which sits at the same
trust level as `/plans`: it accepts the **publishable key** as well as a secret
key, so either side can fetch it — `billing.getProviders()` on your server, or
`listBillingProviders()` in the browser. The component itself issues no API
calls.

Standalone, inside any checkout form — uncontrolled mode needs no JS:

```tsx
<form action={checkoutAction}>
  <input type="hidden" name="planSlug" value="pro_monthly" />
  <ProviderPicker providers={providers} />
  <button type="submit">Continue</button>
</form>
```

Your action has to forward the choice, or the router will quietly re-pick:

```ts
'use server';
export async function checkoutAction(formData: FormData) {
  const planSlug = String(formData.get('planSlug'));
  const provider = formData.get('provider');
  const { url } = await rekey.billing.createCheckout(session.accessToken, {
    planSlug,
    successUrl,
    cancelUrl,
    ...(provider ? { provider: String(provider) } : {}), // omit → geo router picks
  });
  redirect(url);
}
```

### Billing must be enabled first

`billingConfig.enabled` is `false` on a new Application, and every billing
endpoint answers `403 BILLING_DISABLED` until an operator turns it on in
**Panel → Application → Billing**. `getPlans()` is one of them, so a pricing
page built against a fresh Application renders empty until that is done.

### Org-scoped billing

When `billingConfig.billingSubject === 'org'`, an individual cannot hold a
subscription:

- `<OrganizationSwitcher billingSubject="org">` hides the personal option and
  nudges the user into a team.
- `<PricingTable orgGateBlocking>` replaces the upgrade buttons with a
  "team required" gate rather than leaving dead controls on the page.
- `hiddenFields={{ orgId }}` carries the team into checkout; your action passes
  it as `organizationId`. Omitting it throws `BILLING_ORGANIZATION_REQUIRED`.

Read `billingSubject` from `rekey.applications.me()` on the server rather than
hardcoding it — it is per-Application configuration, and driving the UI from
the live value is the difference between a gate that stays correct and one that
silently rots.

---

## Theming

Every component that renders markup takes `appearance` and `className`. The
seven that render none of their own — `<RekeyProvider>`, `<SignedIn>`,
`<SignedOut>`, `<Loading>`, `<RekeyLoading>`, `<RekeyLoaded>` and `<Protect>` —
take neither, because there is nothing to style. The stylesheet is tokens-based:
one `<style>` block, injected once, scoped under `.rekey-root`, depending on
nothing but the cascade.

### Light / dark

Defaults follow `prefers-color-scheme`. A string is shorthand for pinning it:

```tsx
<SignIn appearance="dark" action={signInAction} />
```

An explicit pin wins over the OS preference.

### Tokens

```tsx
<SignIn
  appearance={{
    baseTheme: 'light',
    variables: {
      colorPrimary: '#6d28d9',
      colorBackground: '#faf5ff',
      borderRadius: '8px',
      fontFamily: 'Inter, sans-serif',
    },
  }}
  action={signInAction}
/>
```

| Variable | Controls |
|---|---|
| `colorPrimary` / `colorPrimaryText` | brand colour + the label colour on top of it |
| `colorBackground` / `colorSurface` | page and card backgrounds |
| `colorText` / `colorTextMuted` | primary and secondary text |
| `colorBorder` | cards, inputs, dividers |
| `colorDanger` | destructive actions and errors |
| `borderRadius`, `fontFamily`, `fontSize`, `spacing` | shape and typography |

The same values are readable as `--rekey-*` custom properties, so you can theme
app-wide from your own CSS instead of per component. The property name is the
kebab-cased variable — `colorPrimary` → `--rekey-color-primary` — with **two
exceptions that are shortened**:

| Variable | Custom property |
|---|---|
| `borderRadius` | `--rekey-radius` (not `--rekey-border-radius`) |
| `fontFamily` | `--rekey-font` (not `--rekey-font-family`) |

### Per-element classes

```tsx
<SignIn
  appearance={{ elements: { buttonPrimary: 'my-cta', card: 'shadow-2xl' } }}
  action={signInAction}
/>
```

Slots: `root`, `card`, `header`, `title`, `subtitle`, `label`, `input`,
`button`, `buttonPrimary`, `buttonSecondary`, `buttonDanger`, `divider`,
`footer`, `avatar`, `menu`, `menuItem`, `badge`, `alert`, `planCard`, `price`.

---

## Backendless mode

For an SPA, mobile or desktop app with no server of its own, pass the
Application's publishable key and call the bootstrap methods directly. The
publishable key only identifies the app; the user still proves who they are.

```tsx
<RekeyProvider apiUrl={apiUrl} publishableKey="rp_pub_myapp-prod_…">
  <App />
</RekeyProvider>
```

```ts
import { RekeyBrowserClient } from '@rekey.dev/react';

const client = new RekeyBrowserClient({ apiUrl, publishableKey: 'rp_pub_…' });

const outcome = await client.signIn({ email, password }); // branch on mfaRequired
const { items: plans } = await client.getPlans();          // {items, page}
const lic     = await client.verifyLicense({ key, machineFingerprint });
```

Available on the browser client: `signUp`, `signIn`, `mfaVerify`,
`requestMagicLink`, `verifyMagicLink`, `refresh`, `signOut`,
`startPasskeyAuthentication`, `verifyPasskeyAuthentication`, `getCurrentUser`,
`getPlans`, `listBillingProviders`, `verifyLicense`, `getSubscription`,
`getEntitlements`, `listPayments`, `listOrganizations`, `createCheckout`,
`cancelSubscription`.

Restrict where the key works with the Application's CORS origin allowlist
(Panel → Application → Access); an off-allowlist origin gets
`403 ORIGIN_NOT_ALLOWED`. Account-management routes still require the secret
key on a server. See [api-keys.md → Publishable key](api-keys.md).

---

## See also

- [quickstart.md](quickstart.md) — get an Application and a key first.
- [auth.md](auth.md) — tokens, MFA, the cross-application guard.
- [billing.md](billing.md) — why checkout is asynchronous and what that means
  for your success page.
- [portal.md](portal.md) — if you would rather not build billing UI at all.
- `packages/sdk-react/README.md` — the same surface, in npm-page form.
