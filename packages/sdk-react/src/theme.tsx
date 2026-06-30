/**
 * Theming for the drop-in components.
 *
 * Design goals:
 *   - **No CSS framework.** The package ships a single `<style>` block keyed on
 *     CSS custom properties (`--relipay-*`). It works in any host app — Tailwind,
 *     vanilla CSS, CSS-in-JS — because it depends on nothing but the cascade.
 *   - **Tokens, not classes.** Every colour / radius / spacing value the
 *     components use resolves to a custom property, so an integrator restyles the
 *     whole kit by overriding a handful of variables (via `appearance.variables`
 *     or their own CSS).
 *   - **Light / dark.** Defaults follow `prefers-color-scheme`. An explicit
 *     `appearance="light" | "dark"` (or `appearance.baseTheme`) pins it.
 *   - **Per-element overrides.** `appearance.elements` maps a slot name to a
 *     className (Clerk's `appearance.elements` pattern, slimmed) so an integrator
 *     can target one part — e.g. `{ button: "my-cta" }` — without re-theming.
 *
 * The style block is injected exactly once per document (guarded by an id), and
 * every component is wrapped by `<Themed>` which establishes the `.relipay-root`
 * scope + applies variable overrides inline.
 */

import * as React from 'react';

/** The token names an integrator may override. All optional. */
export interface AppearanceVariables {
  /** Brand / primary action colour. Default a ReliPay teal. */
  colorPrimary?: string;
  /** Text colour on top of `colorPrimary` (button labels). */
  colorPrimaryText?: string;
  /** Page/section background the widgets sit on. */
  colorBackground?: string;
  /** Card / input surface colour. */
  colorSurface?: string;
  /** Primary text colour. */
  colorText?: string;
  /** Muted/secondary text colour. */
  colorTextMuted?: string;
  /** Border colour for cards, inputs, dividers. */
  colorBorder?: string;
  /** Danger/destructive colour (sign-out everywhere, errors). */
  colorDanger?: string;
  /** Corner radius for cards. */
  borderRadius?: string;
  /** Base font family. */
  fontFamily?: string;
  /** Base font size. */
  fontSize?: string;
  /** Internal spacing unit. */
  spacing?: string;
}

/** Slot names you can attach a className to via `appearance.elements`. */
export type AppearanceElement =
  | 'root'
  | 'card'
  | 'header'
  | 'title'
  | 'subtitle'
  | 'label'
  | 'input'
  | 'button'
  | 'buttonPrimary'
  | 'buttonSecondary'
  | 'buttonDanger'
  | 'divider'
  | 'footer'
  | 'avatar'
  | 'menu'
  | 'menuItem'
  | 'badge'
  | 'alert'
  | 'planCard'
  | 'price';

export interface Appearance {
  /** Pin light or dark, instead of following the OS. */
  baseTheme?: 'light' | 'dark';
  /** Override design tokens. */
  variables?: AppearanceVariables;
  /** Attach extra classNames to individual slots. */
  elements?: Partial<Record<AppearanceElement, string>>;
}

/**
 * The `appearance` prop every component accepts. A bare string is shorthand for
 * `{ baseTheme }`; pass the object form for variable / element overrides.
 */
export type AppearanceProp = Appearance | 'light' | 'dark';

function normalizeAppearance(a: AppearanceProp | undefined): Appearance {
  if (!a) return {};
  if (a === 'light' || a === 'dark') return { baseTheme: a };
  return a;
}

const STYLE_ELEMENT_ID = 'relipay-react-styles';

/**
 * The default stylesheet. Everything is scoped under `.relipay-root` so it can
 * never leak into the host app. Dark mode is expressed twice: once via the
 * `[data-relipay-theme="dark"]` attribute (explicit pin) and once via
 * `@media (prefers-color-scheme: dark)` guarded by `:not([data-relipay-theme])`
 * (so an explicit light pin wins over the OS preference).
 */
const STYLES = `
.relipay-root {
  --relipay-color-primary: #0d9488;
  --relipay-color-primary-text: #ffffff;
  --relipay-color-background: #ffffff;
  --relipay-color-surface: #ffffff;
  --relipay-color-text: #171717;
  --relipay-color-text-muted: #737373;
  --relipay-color-border: #e5e5e5;
  --relipay-color-danger: #dc2626;
  --relipay-radius: 12px;
  --relipay-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --relipay-font-size: 14px;
  --relipay-spacing: 8px;

  color: var(--relipay-color-text);
  font-family: var(--relipay-font);
  font-size: var(--relipay-font-size);
  box-sizing: border-box;
}
.relipay-root *, .relipay-root *::before, .relipay-root *::after { box-sizing: border-box; }

.relipay-root[data-relipay-theme="dark"] {
  --relipay-color-background: #0a0a0a;
  --relipay-color-surface: #171717;
  --relipay-color-text: #f5f5f5;
  --relipay-color-text-muted: #a3a3a3;
  --relipay-color-border: #2e2e2e;
}
@media (prefers-color-scheme: dark) {
  .relipay-root:not([data-relipay-theme]) {
    --relipay-color-background: #0a0a0a;
    --relipay-color-surface: #171717;
    --relipay-color-text: #f5f5f5;
    --relipay-color-text-muted: #a3a3a3;
    --relipay-color-border: #2e2e2e;
  }
}

.relipay-card {
  background: var(--relipay-color-surface);
  border: 1px solid var(--relipay-color-border);
  border-radius: var(--relipay-radius);
  padding: calc(var(--relipay-spacing) * 3);
  display: flex;
  flex-direction: column;
  gap: calc(var(--relipay-spacing) * 1.5);
  max-width: 26rem;
}
.relipay-header { display: flex; flex-direction: column; gap: calc(var(--relipay-spacing) * 0.5); margin-bottom: var(--relipay-spacing); }
.relipay-title { font-size: 1.25rem; font-weight: 600; margin: 0; }
.relipay-subtitle { font-size: 0.875rem; color: var(--relipay-color-text-muted); margin: 0; }
.relipay-label { font-size: 0.75rem; font-weight: 500; color: var(--relipay-color-text-muted); margin-bottom: calc(var(--relipay-spacing) * 0.5); display: block; }
.relipay-field {
  display: flex; flex-direction: column;
}
.relipay-input {
  width: 100%;
  border: 1px solid var(--relipay-color-border);
  border-radius: calc(var(--relipay-radius) - 4px);
  background: var(--relipay-color-background);
  color: var(--relipay-color-text);
  padding: calc(var(--relipay-spacing) * 1.25) calc(var(--relipay-spacing) * 1.5);
  font: inherit;
  outline: none;
  transition: border-color 0.15s;
}
.relipay-input:focus { border-color: var(--relipay-color-primary); }
.relipay-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: calc(var(--relipay-spacing) * 0.75);
  border-radius: calc(var(--relipay-radius) - 4px);
  padding: calc(var(--relipay-spacing) * 1.25) calc(var(--relipay-spacing) * 2);
  font: inherit; font-weight: 600;
  cursor: pointer; border: 1px solid transparent;
  text-decoration: none; line-height: 1.2;
  transition: background 0.15s, opacity 0.15s, border-color 0.15s;
}
.relipay-btn:disabled { opacity: 0.5; cursor: default; }
.relipay-btn-primary { background: var(--relipay-color-primary); color: var(--relipay-color-primary-text); }
.relipay-btn-primary:hover:not(:disabled) { filter: brightness(0.93); }
.relipay-btn-secondary { background: transparent; color: var(--relipay-color-text); border-color: var(--relipay-color-border); }
.relipay-btn-secondary:hover:not(:disabled) { background: var(--relipay-color-border); }
.relipay-btn-danger { background: transparent; color: var(--relipay-color-danger); border-color: var(--relipay-color-danger); }
.relipay-btn-danger:hover:not(:disabled) { background: var(--relipay-color-danger); color: #fff; }
.relipay-btn-block { width: 100%; }

.relipay-divider { display: flex; align-items: center; gap: var(--relipay-spacing); color: var(--relipay-color-text-muted); font-size: 0.75rem; margin: var(--relipay-spacing) 0; }
.relipay-divider::before, .relipay-divider::after { content: ""; flex: 1; height: 1px; background: var(--relipay-color-border); }

.relipay-footer { font-size: 0.8125rem; color: var(--relipay-color-text-muted); text-align: center; margin-top: var(--relipay-spacing); }
.relipay-link { color: var(--relipay-color-primary); text-decoration: none; cursor: pointer; background: none; border: none; font: inherit; padding: 0; }
.relipay-link:hover { text-decoration: underline; }

.relipay-alert { border-radius: calc(var(--relipay-radius) - 4px); padding: calc(var(--relipay-spacing) * 1.25) calc(var(--relipay-spacing) * 1.5); font-size: 0.8125rem; border: 1px solid var(--relipay-color-border); }
.relipay-alert-error { color: var(--relipay-color-danger); border-color: var(--relipay-color-danger); background: color-mix(in srgb, var(--relipay-color-danger) 8%, transparent); }
.relipay-alert-info { color: var(--relipay-color-primary); border-color: var(--relipay-color-primary); background: color-mix(in srgb, var(--relipay-color-primary) 8%, transparent); }

.relipay-badge { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid var(--relipay-color-border); padding: 1px 10px; font-size: 0.6875rem; color: var(--relipay-color-text-muted); }
.relipay-badge-primary { border-color: var(--relipay-color-primary); color: var(--relipay-color-primary); }

.relipay-oauth-list { display: flex; flex-direction: column; gap: var(--relipay-spacing); }

/* UserButton */
.relipay-userbtn { position: relative; display: inline-block; }
.relipay-avatar {
  width: 2rem; height: 2rem; border-radius: 999px;
  background: var(--relipay-color-primary); color: var(--relipay-color-primary-text);
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 0.8125rem; cursor: pointer; border: none; padding: 0;
}
.relipay-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
  min-width: 14rem;
  background: var(--relipay-color-surface);
  border: 1px solid var(--relipay-color-border);
  border-radius: calc(var(--relipay-radius) - 2px);
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  padding: calc(var(--relipay-spacing) * 0.5);
  display: flex; flex-direction: column;
}
.relipay-menu-head { padding: var(--relipay-spacing) calc(var(--relipay-spacing) * 1.25); border-bottom: 1px solid var(--relipay-color-border); margin-bottom: calc(var(--relipay-spacing) * 0.5); }
.relipay-menu-head-email { font-size: 0.8125rem; font-weight: 600; word-break: break-all; }
.relipay-menu-item {
  display: flex; align-items: center; gap: var(--relipay-spacing);
  padding: calc(var(--relipay-spacing) * 1) calc(var(--relipay-spacing) * 1.25);
  border-radius: calc(var(--relipay-radius) - 6px);
  font: inherit; font-size: 0.8125rem; text-align: left;
  background: none; border: none; cursor: pointer; color: var(--relipay-color-text);
  text-decoration: none; width: 100%;
}
.relipay-menu-item:hover { background: var(--relipay-color-border); }
.relipay-menu-item-danger { color: var(--relipay-color-danger); }

/* Pricing table */
.relipay-pricing { display: grid; gap: calc(var(--relipay-spacing) * 2); grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); max-width: none; }
.relipay-plan {
  background: var(--relipay-color-surface);
  border: 1px solid var(--relipay-color-border);
  border-radius: var(--relipay-radius);
  padding: calc(var(--relipay-spacing) * 2.5);
  display: flex; flex-direction: column; gap: var(--relipay-spacing);
}
.relipay-plan-current { border-color: var(--relipay-color-primary); }
.relipay-plan-name { font-weight: 600; }
.relipay-price { font-size: 1.5rem; font-weight: 700; }
.relipay-price-sub { font-size: 0.75rem; font-weight: 400; color: var(--relipay-color-text-muted); }
.relipay-plan-cta { margin-top: auto; }

/* Provider picker ("Pay with…" radio cards) */
.relipay-provider-group { gap: calc(var(--relipay-spacing) * 1); max-width: none; }
.relipay-provider-list { display: flex; flex-wrap: wrap; gap: var(--relipay-spacing); }
.relipay-provider-option {
  display: inline-flex; align-items: center; gap: calc(var(--relipay-spacing) * 1);
  border: 1px solid var(--relipay-color-border);
  border-radius: calc(var(--relipay-radius) - 4px);
  background: var(--relipay-color-background);
  color: var(--relipay-color-text);
  padding: calc(var(--relipay-spacing) * 1.25) calc(var(--relipay-spacing) * 1.75);
  font: inherit; font-weight: 500; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.relipay-provider-option:hover { border-color: var(--relipay-color-primary); }
.relipay-provider-option-selected {
  border-color: var(--relipay-color-primary);
  background: color-mix(in srgb, var(--relipay-color-primary) 8%, transparent);
}
/* Visually hidden but still focusable + form-posting (zero-JS uncontrolled mode). */
.relipay-provider-radio {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.relipay-provider-dot {
  width: 1rem; height: 1rem; border-radius: 999px; flex: none;
  border: 2px solid var(--relipay-color-border);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.relipay-provider-option-selected .relipay-provider-dot {
  border-color: var(--relipay-color-primary);
  box-shadow: inset 0 0 0 3px var(--relipay-color-primary);
}
/* Keyboard focus ring on the (visually hidden) radio reflects onto the card. */
.relipay-provider-option:focus-within {
  outline: 2px solid var(--relipay-color-primary);
  outline-offset: 1px;
}

/* Org switcher */
.relipay-select {
  width: 100%;
  border: 1px solid var(--relipay-color-border);
  border-radius: calc(var(--relipay-radius) - 4px);
  background: var(--relipay-color-background);
  color: var(--relipay-color-text);
  padding: calc(var(--relipay-spacing) * 1.25) calc(var(--relipay-spacing) * 1.5);
  font: inherit;
}
.relipay-member-row {
  display: flex; align-items: center; gap: var(--relipay-spacing);
  border: 1px solid var(--relipay-color-border);
  border-radius: calc(var(--relipay-radius) - 4px);
  padding: var(--relipay-spacing) calc(var(--relipay-spacing) * 1.5);
  font-size: 0.8125rem;
}
.relipay-spacer { margin-left: auto; }
.relipay-spinner {
  width: 1.25rem; height: 1.25rem; border-radius: 999px;
  border: 2px solid var(--relipay-color-border);
  border-top-color: var(--relipay-color-primary);
  animation: relipay-spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes relipay-spin { to { transform: rotate(360deg); } }
.relipay-row { display: flex; align-items: center; gap: var(--relipay-spacing); }
.relipay-stack { display: flex; flex-direction: column; gap: var(--relipay-spacing); }
`;

/** Inject the stylesheet once per document. No-op on the server. */
function useInjectStyles(): void {
  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ELEMENT_ID;
    el.textContent = STYLES;
    document.head.appendChild(el);
  }, []);
}

/** Map appearance variables → inline CSS custom properties. */
function variablesToStyle(vars: AppearanceVariables | undefined): React.CSSProperties {
  if (!vars) return {};
  const s: Record<string, string> = {};
  if (vars.colorPrimary) s['--relipay-color-primary'] = vars.colorPrimary;
  if (vars.colorPrimaryText) s['--relipay-color-primary-text'] = vars.colorPrimaryText;
  if (vars.colorBackground) s['--relipay-color-background'] = vars.colorBackground;
  if (vars.colorSurface) s['--relipay-color-surface'] = vars.colorSurface;
  if (vars.colorText) s['--relipay-color-text'] = vars.colorText;
  if (vars.colorTextMuted) s['--relipay-color-text-muted'] = vars.colorTextMuted;
  if (vars.colorBorder) s['--relipay-color-border'] = vars.colorBorder;
  if (vars.colorDanger) s['--relipay-color-danger'] = vars.colorDanger;
  if (vars.borderRadius) s['--relipay-radius'] = vars.borderRadius;
  if (vars.fontFamily) s['--relipay-font'] = vars.fontFamily;
  if (vars.fontSize) s['--relipay-font-size'] = vars.fontSize;
  if (vars.spacing) s['--relipay-spacing'] = vars.spacing;
  return s as React.CSSProperties;
}

/** Context carrying the resolved appearance to nested helpers (element classNames). */
const AppearanceCtx = React.createContext<Appearance>({});

/** Read the active appearance — used by `cx` to merge element overrides. */
export function useAppearance(): Appearance {
  return React.useContext(AppearanceCtx);
}

/**
 * Class-name helper: joins the kit's own classNames with any per-element
 * override the integrator supplied via `appearance.elements[slot]`.
 */
export function useCx(): (base: string, slot?: AppearanceElement, extra?: string) => string {
  const appearance = useAppearance();
  return React.useCallback(
    (base: string, slot?: AppearanceElement, extra?: string) => {
      const override = slot ? appearance.elements?.[slot] : undefined;
      return [base, override, extra].filter(Boolean).join(' ');
    },
    [appearance],
  );
}

/**
 * Establishes the themed scope. Every public component wraps its tree in this:
 * it injects the stylesheet, sets `.relipay-root` + the theme attribute, and
 * applies variable overrides inline. `className` is forwarded to the root so an
 * integrator can target the whole widget; `appearance.elements.root` is merged
 * in too.
 */
export function Themed({
  appearance,
  className,
  style,
  children,
}: {
  // `| undefined` is explicit so callers can spread possibly-undefined props
  // under `exactOptionalPropertyTypes`.
  appearance?: AppearanceProp | undefined;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  useInjectStyles();
  const resolved = normalizeAppearance(appearance);
  const rootClass = ['relipay-root', resolved.elements?.root, className].filter(Boolean).join(' ');
  const mergedStyle: React.CSSProperties = { ...variablesToStyle(resolved.variables), ...style };
  return (
    <AppearanceCtx.Provider value={resolved}>
      <div
        className={rootClass}
        style={mergedStyle}
        {...(resolved.baseTheme ? { 'data-relipay-theme': resolved.baseTheme } : {})}
      >
        {children}
      </div>
    </AppearanceCtx.Provider>
  );
}
