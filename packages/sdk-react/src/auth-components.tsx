/**
 * Auth widgets — the drop-in `<SignIn>` / `<SignUp>` / `<UserButton>` family.
 *
 * ── Why these take server actions instead of calling the API ──
 *
 * Every `/api/v1/auth/*` endpoint on ReliPay is guarded by the secret-key
 * middleware (`requireApiKey`), which **explicitly rejects public keys**. The
 * browser must never hold the secret key, so these widgets cannot POST
 * credentials to ReliPay directly. Instead — exactly like Clerk's components
 * talk to Clerk's FAPI — they delegate writes to *your* server: you pass a
 * Server Action (or a route URL) and the widget renders the form/buttons around
 * it. Your action runs `@relipay/node` server-side (with the secret) and rotates
 * the session cookie; the provider then reflects the new user on the next load.
 *
 * Two integration styles, pick per prop:
 *   - `action`: a function (Next.js Server Action) wired to `<form action={…}>`.
 *     Progressive-enhancement friendly; the action does the redirect.
 *   - `*Url`: a string the form POSTs to (classic route handler). Used when you
 *     aren't on the App Router server-action model.
 *
 * Implementation note: each widget is a thin `<Themed>` wrapper around an inner
 * `…Body` component. `useCx()` (which reads the appearance context `<Themed>`
 * provides) is only ever called inside the body, so per-element className
 * overrides resolve correctly.
 */

import * as React from 'react';
import { useUser } from './hooks.js';
import { Themed, useCx, type AppearanceProp } from './theme.js';

/** A Next.js Server Action bound to a `<form>` — `(formData) => void | Promise<void>`. */
export type FormAction = (formData: FormData) => void | Promise<void>;

/** A provider button descriptor for OAuth sign-in. The `startUrl`/`startAction`
 *  kicks off your server's OAuth redirect for that provider. */
export interface OAuthProvider {
  /** Provider id, e.g. `"google"`, `"github"`. */
  provider: string;
  /** Human label, e.g. `"Continue with Google"`. Defaults from `provider`. */
  label?: string;
  /** Server Action that begins the OAuth dance (returns/redirects to provider). */
  startAction?: FormAction;
  /** Or a URL to navigate to that begins the OAuth dance. */
  startUrl?: string;
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Shared OAuth button list. Renders one button per configured provider. */
function OAuthButtons({ providers }: { providers: OAuthProvider[] }): React.JSX.Element | null {
  const cx = useCx();
  if (providers.length === 0) return null;
  return (
    <div className="relipay-oauth-list">
      {providers.map((p) => {
        const label = p.label ?? `Continue with ${titleCase(p.provider)}`;
        if (p.startAction) {
          return (
            <form key={p.provider} action={p.startAction}>
              <button
                type="submit"
                className={cx('relipay-btn relipay-btn-secondary relipay-btn-block', 'buttonSecondary')}
              >
                {label}
              </button>
            </form>
          );
        }
        return (
          <a
            key={p.provider}
            href={p.startUrl ?? '#'}
            className={cx('relipay-btn relipay-btn-secondary relipay-btn-block', 'buttonSecondary')}
          >
            {label}
          </a>
        );
      })}
    </div>
  );
}

/** Inline error/info banner (server flows surface a message via this). */
function Alert({ kind, children }: { kind: 'error' | 'info'; children: React.ReactNode }): React.JSX.Element | null {
  const cx = useCx();
  if (!children) return null;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={cx(`relipay-alert relipay-alert-${kind}`, 'alert')}>
      {children}
    </div>
  );
}

/** Form props spread helper — prefer the Server Action, else POST to the URL. */
function formProps(action?: FormAction, url?: string): { action: FormAction } | { action: string; method: 'post' } | Record<string, never> {
  if (action) return { action };
  if (url) return { action: url, method: 'post' };
  return {};
}

// ---------------------------------------------------------------------------
// <SignIn>
// ---------------------------------------------------------------------------

export interface SignInProps {
  /** Server Action for email+password sign-in. Reads `email` + `password` from FormData. */
  action?: FormAction;
  /** Or a route URL the form POSTs to. */
  actionUrl?: string;
  /** Magic-link Server Action (reads `email`). Renders the magic-link affordance when set. */
  magicLinkAction?: FormAction;
  /** Or a magic-link route URL. */
  magicLinkUrl?: string;
  /** OAuth providers to render as buttons (configure on your app). */
  oauthProviders?: OAuthProvider[];
  /** Link target for "Create account". Omit to hide. */
  signUpUrl?: string;
  /** Link target for "Forgot password?". Omit to hide. */
  forgotPasswordUrl?: string;
  /** Error message to surface (e.g. mapped from `?error=` after a failed POST). */
  error?: React.ReactNode;
  /** Heading. */
  title?: string;
  subtitle?: string;
  appearance?: AppearanceProp;
  className?: string;
}

function SignInBody(props: SignInProps): React.JSX.Element {
  const cx = useCx();
  const {
    action, actionUrl, magicLinkAction, magicLinkUrl,
    oauthProviders = [], signUpUrl, forgotPasswordUrl, error,
    title = 'Sign in', subtitle,
  } = props;
  return (
    <div className={cx('relipay-card', 'card')}>
      <div className={cx('relipay-header', 'header')}>
        <h1 className={cx('relipay-title', 'title')}>{title}</h1>
        {subtitle && <p className={cx('relipay-subtitle', 'subtitle')}>{subtitle}</p>}
      </div>

      <Alert kind="error">{error}</Alert>

      <OAuthButtons providers={oauthProviders} />
      {oauthProviders.length > 0 && <div className={cx('relipay-divider', 'divider')}>or</div>}

      <form {...formProps(action, actionUrl)} className="relipay-stack">
        <div className="relipay-field">
          <label className={cx('relipay-label', 'label')} htmlFor="relipay-signin-email">Email</label>
          <input
            id="relipay-signin-email" name="email" type="email" required autoComplete="email"
            placeholder="you@example.com" className={cx('relipay-input', 'input')}
          />
        </div>
        <div className="relipay-field">
          <label className={cx('relipay-label', 'label')} htmlFor="relipay-signin-password">Password</label>
          <input
            id="relipay-signin-password" name="password" type="password" required autoComplete="current-password"
            placeholder="Your password" className={cx('relipay-input', 'input')}
          />
        </div>
        <button type="submit" className={cx('relipay-btn relipay-btn-primary relipay-btn-block', 'buttonPrimary')}>
          Sign in
        </button>
      </form>

      {(magicLinkAction || magicLinkUrl) && (
        <>
          <div className={cx('relipay-divider', 'divider')}>or use a magic link</div>
          <form {...formProps(magicLinkAction, magicLinkUrl)} className="relipay-row">
            <input
              name="email" type="email" required autoComplete="email" aria-label="Email for magic link"
              placeholder="you@example.com" className={cx('relipay-input', 'input')}
            />
            <button
              type="submit" className={cx('relipay-btn relipay-btn-secondary', 'buttonSecondary')}
              style={{ flexShrink: 0 }}
            >
              Email link
            </button>
          </form>
        </>
      )}

      {(signUpUrl || forgotPasswordUrl) && (
        <div className={cx('relipay-footer', 'footer')}>
          {signUpUrl && <a className="relipay-link" href={signUpUrl}>Create account</a>}
          {signUpUrl && forgotPasswordUrl && ' · '}
          {forgotPasswordUrl && <a className="relipay-link" href={forgotPasswordUrl}>Forgot password?</a>}
        </div>
      )}
    </div>
  );
}

/**
 * Drop-in sign-in card: email + password, optional magic-link, optional OAuth.
 * Delegates the actual sign-in to your server (`action` / `actionUrl`).
 *
 * @example (Next.js App Router)
 * ```tsx
 * import { signInAction, magicLinkAction } from "@/lib/actions";
 * <SignIn
 *   action={signInAction}
 *   magicLinkAction={magicLinkAction}
 *   oauthProviders={[{ provider: "google", startAction: startGoogle }]}
 *   signUpUrl="/signup"
 *   forgotPasswordUrl="/forgot-password"
 * />
 * ```
 */
export function SignIn(props: SignInProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <SignInBody {...props} />
    </Themed>
  );
}

// ---------------------------------------------------------------------------
// <SignUp>
// ---------------------------------------------------------------------------

export interface SignUpProps {
  /** Server Action for sign-up. Reads `email` + `password` from FormData. */
  action?: FormAction;
  /** Or a route URL the form POSTs to. */
  actionUrl?: string;
  /** OAuth providers to render as buttons. */
  oauthProviders?: OAuthProvider[];
  /** Link target for "Already have an account?". Omit to hide. */
  signInUrl?: string;
  /** Error message to surface. */
  error?: React.ReactNode;
  title?: string;
  subtitle?: string;
  appearance?: AppearanceProp;
  className?: string;
}

function SignUpBody(props: SignUpProps): React.JSX.Element {
  const cx = useCx();
  const {
    action, actionUrl, oauthProviders = [], signInUrl, error,
    title = 'Create your account', subtitle,
  } = props;
  return (
    <div className={cx('relipay-card', 'card')}>
      <div className={cx('relipay-header', 'header')}>
        <h1 className={cx('relipay-title', 'title')}>{title}</h1>
        {subtitle && <p className={cx('relipay-subtitle', 'subtitle')}>{subtitle}</p>}
      </div>

      <Alert kind="error">{error}</Alert>

      <OAuthButtons providers={oauthProviders} />
      {oauthProviders.length > 0 && <div className={cx('relipay-divider', 'divider')}>or</div>}

      <form {...formProps(action, actionUrl)} className="relipay-stack">
        <div className="relipay-field">
          <label className={cx('relipay-label', 'label')} htmlFor="relipay-signup-email">Email</label>
          <input
            id="relipay-signup-email" name="email" type="email" required autoComplete="email"
            placeholder="you@example.com" className={cx('relipay-input', 'input')}
          />
        </div>
        <div className="relipay-field">
          <label className={cx('relipay-label', 'label')} htmlFor="relipay-signup-password">Password</label>
          <input
            id="relipay-signup-password" name="password" type="password" required autoComplete="new-password"
            placeholder="Choose a strong password" className={cx('relipay-input', 'input')}
          />
        </div>
        <button type="submit" className={cx('relipay-btn relipay-btn-primary relipay-btn-block', 'buttonPrimary')}>
          Create account
        </button>
      </form>

      {signInUrl && (
        <div className={cx('relipay-footer', 'footer')}>
          Already have an account? <a className="relipay-link" href={signInUrl}>Sign in</a>
        </div>
      )}
    </div>
  );
}

/**
 * Drop-in sign-up card. Like `<SignIn>` but posts to your sign-up action.
 *
 * @example
 * ```tsx
 * <SignUp action={signUpAction} signInUrl="/login" />
 * ```
 */
export function SignUp(props: SignUpProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <SignUpBody {...props} />
    </Themed>
  );
}

// ---------------------------------------------------------------------------
// Button helpers: <SignInButton> / <SignUpButton> / <SignOutButton>
// ---------------------------------------------------------------------------

export interface NavButtonProps {
  /** Where to send the user (your sign-in/up page). */
  url?: string;
  /** Or a Server Action (e.g. sign-out) to invoke instead of navigating. */
  action?: FormAction;
  children?: React.ReactNode;
  appearance?: AppearanceProp;
  className?: string;
  /** Visual variant. */
  variant?: 'primary' | 'secondary' | 'danger';
}

function NavButtonBody({
  url, action, children, variant, fallbackLabel,
}: NavButtonProps & { variant: 'primary' | 'secondary' | 'danger'; fallbackLabel: string }): React.JSX.Element {
  const cx = useCx();
  const slot = variant === 'primary' ? 'buttonPrimary' : variant === 'danger' ? 'buttonDanger' : 'buttonSecondary';
  const klass = cx(`relipay-btn relipay-btn-${variant}`, slot);
  const label = children ?? fallbackLabel;
  return action ? (
    <form action={action}>
      <button type="submit" className={klass}>{label}</button>
    </form>
  ) : (
    <a href={url ?? '#'} className={klass}>{label}</a>
  );
}

function NavButton(props: NavButtonProps & { variant: 'primary' | 'secondary' | 'danger'; fallbackLabel: string }): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className} style={{ display: 'inline-block' }}>
      <NavButtonBody {...props} />
    </Themed>
  );
}

/** A button that navigates to your sign-in page. */
export function SignInButton(props: NavButtonProps): React.JSX.Element {
  return <NavButton {...props} variant={props.variant ?? 'primary'} fallbackLabel="Sign in" />;
}

/** A button that navigates to your sign-up page. */
export function SignUpButton(props: NavButtonProps): React.JSX.Element {
  return <NavButton {...props} variant={props.variant ?? 'secondary'} fallbackLabel="Sign up" />;
}

/** A button (form) that invokes your sign-out Server Action. */
export function SignOutButton(props: NavButtonProps): React.JSX.Element {
  return <NavButton {...props} variant={props.variant ?? 'secondary'} fallbackLabel="Sign out" />;
}

// ---------------------------------------------------------------------------
// <UserButton>
// ---------------------------------------------------------------------------

export interface UserButtonProps {
  /** Sign-out Server Action. Rendered as the menu's "Sign out" item. */
  signOutAction?: FormAction;
  /** Or a sign-out route URL. */
  signOutUrl?: string;
  /** "Manage account" link target (e.g. /account). Omit to hide. */
  manageAccountUrl?: string;
  /** "Active sessions / devices" link target. Omit to hide. */
  sessionsUrl?: string;
  /** Extra menu items, rendered above sign-out. */
  extraItems?: Array<{ label: string; href?: string; onClick?: () => void }>;
  appearance?: AppearanceProp;
  className?: string;
}

function UserButtonBody({
  signOutAction, signOutUrl, manageAccountUrl, sessionsUrl, extraItems = [],
}: UserButtonProps): React.JSX.Element | null {
  const { user, signedIn, loading } = useUser();
  const cx = useCx();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (loading || !signedIn || !user) return null;
  const initial = (user.email?.[0] ?? '?').toUpperCase();

  return (
    <div className="relipay-userbtn" ref={ref}>
      <button
        type="button"
        className={cx('relipay-avatar', 'avatar')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        {initial}
      </button>
      {open && (
        <div className={cx('relipay-menu', 'menu')} role="menu">
          <div className="relipay-menu-head">
            <div className="relipay-menu-head-email">{user.email}</div>
          </div>
          {manageAccountUrl && (
            <a className={cx('relipay-menu-item', 'menuItem')} href={manageAccountUrl} role="menuitem">
              Manage account
            </a>
          )}
          {sessionsUrl && (
            <a className={cx('relipay-menu-item', 'menuItem')} href={sessionsUrl} role="menuitem">
              Sessions &amp; devices
            </a>
          )}
          {extraItems.map((it, i) =>
            it.href ? (
              <a key={i} className={cx('relipay-menu-item', 'menuItem')} href={it.href} role="menuitem">
                {it.label}
              </a>
            ) : (
              <button
                key={i} type="button" className={cx('relipay-menu-item', 'menuItem')}
                role="menuitem" onClick={it.onClick}
              >
                {it.label}
              </button>
            ),
          )}
          {signOutAction ? (
            <form action={signOutAction}>
              <button
                type="submit" className={cx('relipay-menu-item relipay-menu-item-danger', 'menuItem')}
                role="menuitem"
              >
                Sign out
              </button>
            </form>
          ) : (
            <a
              className={cx('relipay-menu-item relipay-menu-item-danger', 'menuItem')}
              href={signOutUrl ?? '#'} role="menuitem"
            >
              Sign out
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Avatar + dropdown menu for the signed-in user (Clerk's `<UserButton>`).
 * Renders nothing when signed out. The avatar shows the user's email initial.
 *
 * @example
 * ```tsx
 * <UserButton
 *   manageAccountUrl="/account"
 *   sessionsUrl="/account#sessions"
 *   signOutAction={signOutAction}
 * />
 * ```
 */
export function UserButton(props: UserButtonProps): React.JSX.Element | null {
  const { signedIn, loading } = useUser();
  // Skip the themed wrapper entirely when signed out — avoids injecting an empty
  // root node into the header.
  if (loading || !signedIn) return null;
  return (
    <Themed appearance={props.appearance} className={props.className} style={{ display: 'inline-block' }}>
      <UserButtonBody {...props} />
    </Themed>
  );
}
