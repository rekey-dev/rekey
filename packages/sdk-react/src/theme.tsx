'use client';

/**
 * Theming for the drop-in components.
 *
 * Design goals:
 *   - **No CSS framework.** The package ships a single `<style>` block keyed on
 *     CSS custom properties (`--rekey-*`). It works in any host app — Tailwind,
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
 * every component is wrapped by `<Themed>` which establishes the `.rekey-root`
 * scope + applies variable overrides inline.
 */

import * as React from 'react';

/** The token names an integrator may override. All optional. */
export interface AppearanceVariables {
  /** Brand / primary action colour. Default a Rekey teal. */
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

const STYLE_ELEMENT_ID = 'rekey-react-styles';

/**
 * The default stylesheet. Everything is scoped under `.rekey-root` so it can
 * never leak into the host app. Dark mode is expressed twice: once via the
 * `[data-rekey-theme="dark"]` attribute (explicit pin) and once via
 * `@media (prefers-color-scheme: dark)` guarded by `:not([data-rekey-theme])`
 * (so an explicit light pin wins over the OS preference).
 */
const STYLES = `
.rekey-root {
  --rekey-color-primary: #0d9488;
  --rekey-color-primary-text: #ffffff;
  --rekey-color-background: #ffffff;
  --rekey-color-surface: #ffffff;
  --rekey-color-text: #171717;
  --rekey-color-text-muted: #737373;
  --rekey-color-border: #e5e5e5;
  --rekey-color-danger: #dc2626;
  --rekey-radius: 12px;
  --rekey-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --rekey-font-size: 14px;
  --rekey-spacing: 8px;

  color: var(--rekey-color-text);
  font-family: var(--rekey-font);
  font-size: var(--rekey-font-size);
  box-sizing: border-box;
}
.rekey-root *, .rekey-root *::before, .rekey-root *::after { box-sizing: border-box; }

.rekey-root[data-rekey-theme="dark"] {
  --rekey-color-background: #0a0a0a;
  --rekey-color-surface: #171717;
  --rekey-color-text: #f5f5f5;
  --rekey-color-text-muted: #a3a3a3;
  --rekey-color-border: #2e2e2e;
}
@media (prefers-color-scheme: dark) {
  .rekey-root:not([data-rekey-theme]) {
    --rekey-color-background: #0a0a0a;
    --rekey-color-surface: #171717;
    --rekey-color-text: #f5f5f5;
    --rekey-color-text-muted: #a3a3a3;
    --rekey-color-border: #2e2e2e;
  }
}

.rekey-card {
  background: var(--rekey-color-surface);
  border: 1px solid var(--rekey-color-border);
  border-radius: var(--rekey-radius);
  padding: calc(var(--rekey-spacing) * 3);
  display: flex;
  flex-direction: column;
  gap: calc(var(--rekey-spacing) * 1.5);
  max-width: 26rem;
}
.rekey-header { display: flex; flex-direction: column; gap: calc(var(--rekey-spacing) * 0.5); margin-bottom: var(--rekey-spacing); }
.rekey-title { font-size: 1.25rem; font-weight: 600; margin: 0; }
.rekey-subtitle { font-size: 0.875rem; color: var(--rekey-color-text-muted); margin: 0; }
.rekey-label { font-size: 0.75rem; font-weight: 500; color: var(--rekey-color-text-muted); margin-bottom: calc(var(--rekey-spacing) * 0.5); display: block; }
.rekey-field {
  display: flex; flex-direction: column;
}
.rekey-input {
  width: 100%;
  border: 1px solid var(--rekey-color-border);
  border-radius: calc(var(--rekey-radius) - 4px);
  background: var(--rekey-color-background);
  color: var(--rekey-color-text);
  padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 1.5);
  font: inherit;
  outline: none;
  transition: border-color 0.15s;
}
.rekey-input:focus { border-color: var(--rekey-color-primary); }
.rekey-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: calc(var(--rekey-spacing) * 0.75);
  border-radius: calc(var(--rekey-radius) - 4px);
  padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 2);
  font: inherit; font-weight: 600;
  cursor: pointer; border: 1px solid transparent;
  text-decoration: none; line-height: 1.2;
  transition: background 0.15s, opacity 0.15s, border-color 0.15s;
}
.rekey-btn:disabled { opacity: 0.5; cursor: default; }
.rekey-btn-primary { background: var(--rekey-color-primary); color: var(--rekey-color-primary-text); }
.rekey-btn-primary:hover:not(:disabled) { filter: brightness(0.93); }
.rekey-btn-secondary { background: transparent; color: var(--rekey-color-text); border-color: var(--rekey-color-border); }
.rekey-btn-secondary:hover:not(:disabled) { background: var(--rekey-color-border); }
.rekey-btn-danger { background: transparent; color: var(--rekey-color-danger); border-color: var(--rekey-color-danger); }
.rekey-btn-danger:hover:not(:disabled) { background: var(--rekey-color-danger); color: #fff; }
.rekey-btn-block { width: 100%; }

.rekey-divider { display: flex; align-items: center; gap: var(--rekey-spacing); color: var(--rekey-color-text-muted); font-size: 0.75rem; margin: var(--rekey-spacing) 0; }
.rekey-divider::before, .rekey-divider::after { content: ""; flex: 1; height: 1px; background: var(--rekey-color-border); }

.rekey-footer { font-size: 0.8125rem; color: var(--rekey-color-text-muted); text-align: center; margin-top: var(--rekey-spacing); }
.rekey-link { color: var(--rekey-color-primary); text-decoration: none; cursor: pointer; background: none; border: none; font: inherit; padding: 0; }
.rekey-link:hover { text-decoration: underline; }

.rekey-alert { border-radius: calc(var(--rekey-radius) - 4px); padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 1.5); font-size: 0.8125rem; border: 1px solid var(--rekey-color-border); }
.rekey-alert-error { color: var(--rekey-color-danger); border-color: var(--rekey-color-danger); background: color-mix(in srgb, var(--rekey-color-danger) 8%, transparent); }
.rekey-alert-info { color: var(--rekey-color-primary); border-color: var(--rekey-color-primary); background: color-mix(in srgb, var(--rekey-color-primary) 8%, transparent); }

.rekey-badge { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid var(--rekey-color-border); padding: 1px 10px; font-size: 0.6875rem; color: var(--rekey-color-text-muted); }
.rekey-badge-primary { border-color: var(--rekey-color-primary); color: var(--rekey-color-primary); }

.rekey-oauth-list { display: flex; flex-direction: column; gap: var(--rekey-spacing); }

/* UserButton */
.rekey-userbtn { position: relative; display: inline-block; }
.rekey-avatar {
  width: 2rem; height: 2rem; border-radius: 999px;
  background: var(--rekey-color-primary); color: var(--rekey-color-primary-text);
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 0.8125rem; cursor: pointer; border: none; padding: 0;
}
.rekey-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
  min-width: 14rem;
  background: var(--rekey-color-surface);
  border: 1px solid var(--rekey-color-border);
  border-radius: calc(var(--rekey-radius) - 2px);
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  padding: calc(var(--rekey-spacing) * 0.5);
  display: flex; flex-direction: column;
}
.rekey-menu-head { padding: var(--rekey-spacing) calc(var(--rekey-spacing) * 1.25); border-bottom: 1px solid var(--rekey-color-border); margin-bottom: calc(var(--rekey-spacing) * 0.5); }
.rekey-menu-head-email { font-size: 0.8125rem; font-weight: 600; word-break: break-all; }
.rekey-menu-item {
  display: flex; align-items: center; gap: var(--rekey-spacing);
  padding: calc(var(--rekey-spacing) * 1) calc(var(--rekey-spacing) * 1.25);
  border-radius: calc(var(--rekey-radius) - 6px);
  font: inherit; font-size: 0.8125rem; text-align: left;
  background: none; border: none; cursor: pointer; color: var(--rekey-color-text);
  text-decoration: none; width: 100%;
}
.rekey-menu-item:hover { background: var(--rekey-color-border); }
.rekey-menu-item-danger { color: var(--rekey-color-danger); }

/* Pricing table */
.rekey-pricing { display: grid; gap: calc(var(--rekey-spacing) * 2); grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); max-width: none; }
.rekey-plan {
  background: var(--rekey-color-surface);
  border: 1px solid var(--rekey-color-border);
  border-radius: var(--rekey-radius);
  padding: calc(var(--rekey-spacing) * 2.5);
  display: flex; flex-direction: column; gap: var(--rekey-spacing);
}
.rekey-plan-current { border-color: var(--rekey-color-primary); }
.rekey-plan-name { font-weight: 600; }
.rekey-price { font-size: 1.5rem; font-weight: 700; }
.rekey-price-sub { font-size: 0.75rem; font-weight: 400; color: var(--rekey-color-text-muted); }
.rekey-plan-cta { margin-top: auto; }

/* Provider picker ("Pay with…" radio cards) */
.rekey-provider-group { gap: calc(var(--rekey-spacing) * 1); max-width: none; }
.rekey-provider-list { display: flex; flex-wrap: wrap; gap: var(--rekey-spacing); }
.rekey-provider-option {
  display: inline-flex; align-items: center; gap: calc(var(--rekey-spacing) * 1);
  border: 1px solid var(--rekey-color-border);
  border-radius: calc(var(--rekey-radius) - 4px);
  background: var(--rekey-color-background);
  color: var(--rekey-color-text);
  padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 1.75);
  font: inherit; font-weight: 500; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.rekey-provider-option:hover { border-color: var(--rekey-color-primary); }
.rekey-provider-option-selected {
  border-color: var(--rekey-color-primary);
  background: color-mix(in srgb, var(--rekey-color-primary) 8%, transparent);
}
/* Visually hidden but still focusable + form-posting (zero-JS uncontrolled mode). */
.rekey-provider-radio {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.rekey-provider-dot {
  width: 1rem; height: 1rem; border-radius: 999px; flex: none;
  border: 2px solid var(--rekey-color-border);
  transition: border-color 0.15s, box-shadow 0.15s;
}
.rekey-provider-option-selected .rekey-provider-dot {
  border-color: var(--rekey-color-primary);
  box-shadow: inset 0 0 0 3px var(--rekey-color-primary);
}
/* Keyboard focus ring on the (visually hidden) radio reflects onto the card. */
.rekey-provider-option:focus-within {
  outline: 2px solid var(--rekey-color-primary);
  outline-offset: 1px;
}

/* Org switcher */
.rekey-select {
  width: 100%;
  border: 1px solid var(--rekey-color-border);
  border-radius: calc(var(--rekey-radius) - 4px);
  background: var(--rekey-color-background);
  color: var(--rekey-color-text);
  padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 1.5);
  font: inherit;
}
.rekey-member-row {
  display: flex; align-items: center; gap: var(--rekey-spacing);
  border: 1px solid var(--rekey-color-border);
  border-radius: calc(var(--rekey-radius) - 4px);
  padding: var(--rekey-spacing) calc(var(--rekey-spacing) * 1.5);
  font-size: 0.8125rem;
}
.rekey-spacer { margin-left: auto; }
.rekey-spinner {
  width: 1.25rem; height: 1.25rem; border-radius: 999px;
  border: 2px solid var(--rekey-color-border);
  border-top-color: var(--rekey-color-primary);
  animation: rekey-spin 0.7s linear infinite;
  display: inline-block;
}
@keyframes rekey-spin { to { transform: rotate(360deg); } }
.rekey-row { display: flex; align-items: center; gap: var(--rekey-spacing); }
.rekey-stack { display: flex; flex-direction: column; gap: var(--rekey-spacing); }
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
  if (vars.colorPrimary) s['--rekey-color-primary'] = vars.colorPrimary;
  if (vars.colorPrimaryText) s['--rekey-color-primary-text'] = vars.colorPrimaryText;
  if (vars.colorBackground) s['--rekey-color-background'] = vars.colorBackground;
  if (vars.colorSurface) s['--rekey-color-surface'] = vars.colorSurface;
  if (vars.colorText) s['--rekey-color-text'] = vars.colorText;
  if (vars.colorTextMuted) s['--rekey-color-text-muted'] = vars.colorTextMuted;
  if (vars.colorBorder) s['--rekey-color-border'] = vars.colorBorder;
  if (vars.colorDanger) s['--rekey-color-danger'] = vars.colorDanger;
  if (vars.borderRadius) s['--rekey-radius'] = vars.borderRadius;
  if (vars.fontFamily) s['--rekey-font'] = vars.fontFamily;
  if (vars.fontSize) s['--rekey-font-size'] = vars.fontSize;
  if (vars.spacing) s['--rekey-spacing'] = vars.spacing;
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
 * it injects the stylesheet, sets `.rekey-root` + the theme attribute, and
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
  const rootClass = ['rekey-root', resolved.elements?.root, className].filter(Boolean).join(' ');
  const mergedStyle: React.CSSProperties = { ...variablesToStyle(resolved.variables), ...style };
  return (
    <AppearanceCtx.Provider value={resolved}>
      <div
        className={rootClass}
        style={mergedStyle}
        {...(resolved.baseTheme ? { 'data-rekey-theme': resolved.baseTheme } : {})}
      >
        {children}
      </div>
    </AppearanceCtx.Provider>
  );
}
