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
  /**
   * Corner radius for surfaces — cards, plan tiles, menus.
   *
   * Defaults to 2px. Rekey's own look is flat and editorial: hairline rules
   * and square corners, with the accent colour doing the work that a rounded,
   * shadowed card would do elsewhere. Raise it if your product is softer.
   */
  borderRadius?: string;
  /**
   * Corner radius for controls — inputs, buttons, badges.
   *
   * Separate from `borderRadius` because these used to be derived from it by
   * subtraction, which silently broke at small values: a 2px surface radius
   * made every control `calc(2px - 4px)`.
   *
   * Defaults to whatever `borderRadius` is set to, so the one knob the docs
   * have always taught keeps driving both. Set this only when the two should
   * genuinely differ.
   */
  borderRadiusControl?: string;
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
export const STYLES = `
.rekey-root {
  --rekey-color-primary: #0d9488;
  --rekey-color-primary-text: #ffffff;
  --rekey-color-background: #ffffff;
  --rekey-color-surface: #ffffff;
  --rekey-color-text: #171717;
  --rekey-color-text-muted: #6b6b6b;
  --rekey-color-border: #d4d4d4;
  --rekey-color-danger: #dc2626;
  /* Flat and editorial. The accent and the hairline rules carry the design;
     rounding and shadows are not asked to. Both are overridable, and an
     integrator who wants a softer product raises them together. */
  --rekey-radius: 2px;
  --rekey-radius-control: 2px;
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
  border-radius: var(--rekey-radius-control);
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
  border-radius: var(--rekey-radius-control);
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

.rekey-alert { border-radius: var(--rekey-radius-control); padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 1.5); font-size: 0.8125rem; border: 1px solid var(--rekey-color-border); }
.rekey-alert-error { color: var(--rekey-color-danger); border-color: var(--rekey-color-danger); background: color-mix(in srgb, var(--rekey-color-danger) 8%, transparent); }
.rekey-alert-info { color: var(--rekey-color-primary); border-color: var(--rekey-color-primary); background: color-mix(in srgb, var(--rekey-color-primary) 8%, transparent); }

.rekey-badge {
  display: inline-flex; align-items: center;
  border-radius: var(--rekey-radius-control);
  border: 1px solid var(--rekey-color-border);
  padding: 1px 8px;
  font-size: 0.6875rem;
  text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600;
  color: var(--rekey-color-text-muted);
}
.rekey-badge-primary { border-color: var(--rekey-color-primary); color: var(--rekey-color-primary); }

/* Small uppercase section label. The typographic device the rest of Rekey uses
   to introduce a block without spending a heading level on it. */
.rekey-eyebrow {
  display: block;
  font-size: 0.6875rem; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--rekey-color-text-muted);
}

.rekey-oauth-list { display: flex; flex-direction: column; gap: var(--rekey-spacing); }

/* UserButton */
.rekey-userbtn { position: relative; display: inline-block; }
.rekey-avatar {
  width: 2rem; height: 2rem; border-radius: var(--rekey-radius-control);
  background: var(--rekey-color-primary); color: var(--rekey-color-primary-text);
  display: inline-flex; align-items: center; justify-content: center;
  font-weight: 600; font-size: 0.8125rem; cursor: pointer; border: none; padding: 0;
}
.rekey-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 50;
  min-width: 14rem;
  background: var(--rekey-color-surface);
  border: 1px solid var(--rekey-color-border);
  border-radius: var(--rekey-radius-control);
  /* A hairline and a solid surface, not a drop shadow. The menu is above the
     page because it overlaps it, and it reads that way without pretending to
     float. Solid because a translucent menu over arbitrary host content is
     unreadable in exactly the cases nobody tests. */
  padding: calc(var(--rekey-spacing) * 0.5);
  display: flex; flex-direction: column;
}
.rekey-menu-head { padding: var(--rekey-spacing) calc(var(--rekey-spacing) * 1.25); border-bottom: 1px solid var(--rekey-color-border); margin-bottom: calc(var(--rekey-spacing) * 0.5); }
.rekey-menu-head-email { font-size: 0.8125rem; font-weight: 600; word-break: break-all; }
.rekey-menu-item {
  display: flex; align-items: center; gap: var(--rekey-spacing);
  padding: calc(var(--rekey-spacing) * 1) calc(var(--rekey-spacing) * 1.25);
  border-radius: var(--rekey-radius-control);
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
/* The plan you are on, marked with a solid rule rather than a tint. A tinted
   card competes with the CTA for the same attention; a rule states a fact. */
.rekey-plan-current { border-color: var(--rekey-color-primary); border-top-width: 2px; }
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
  border-radius: var(--rekey-radius-control);
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
  border-radius: var(--rekey-radius-control);
  background: var(--rekey-color-background);
  color: var(--rekey-color-text);
  padding: calc(var(--rekey-spacing) * 1.25) calc(var(--rekey-spacing) * 1.5);
  font: inherit;
}
.rekey-member-row {
  display: flex; align-items: center; gap: var(--rekey-spacing);
  border: 1px solid var(--rekey-color-border);
  border-radius: var(--rekey-radius-control);
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

/**
 * Marks that an ancestor `<Themed>` has already rendered the stylesheet, so a
 * page with several components does not repeat it.
 */
const StylesRenderedCtx = React.createContext(false);

/**
 * The stylesheet, rendered into the tree rather than injected by an effect.
 *
 * It used to be appended to `document.head` from a `useEffect`. That works in
 * Next, where these components hydrate anyway, and fails everywhere the
 * components are rendered server-only: Astro without a client directive gets
 * correct markup with no styling at all, because the effect never runs. The
 * workaround — adding a client directive — ships React to a page that needs
 * none, purely to get a stylesheet, which made the whole component set
 * effectively Next-only.
 *
 * Rendering it in the tree covers both: the server pass emits it, and a
 * client-only mount emits it too. `<style>` in the body is valid HTML and
 * scoped rules are unaffected by where the element sits. The id is kept so an
 * app that injected it by other means can still find it.
 *
 * For consumers who would rather link a real file — a global stylesheet, a
 * CDN, a strict CSP that forbids inline styles — `@rekey.dev/react/styles.css`
 * is the same content, generated from this constant at build time.
 */
function StyleSheet(): React.JSX.Element {
  // A data attribute rather than an id. Nesting is deduplicated by
  // StylesRenderedCtx, but two Rekey components as *siblings* each render
  // their own copy, and duplicate ids are invalid HTML. Duplicate rules are
  // merely redundant, and `<RekeyStyles />` or the stylesheet file avoid even
  // that for anyone who cares about the bytes.
  //
  // Deliberately does not consult StylesRenderedCtx itself: it renders inside
  // the provider that sets the flag, so checking here would make it suppress
  // itself. `Themed` decides, before entering the provider.
  return <style data-rekey-styles="" dangerouslySetInnerHTML={{ __html: STYLES }} />;
}

/**
 * Render the component stylesheet once, yourself.
 *
 * Optional. Every Rekey component brings its own copy, so things look right
 * without this. Put it in your layout — inside `<head>` if your framework
 * allows — when you would rather have one copy than one per component, and
 * wrap the rest of the tree so they know to skip theirs:
 *
 * ```tsx
 * <RekeyStyles>
 *   <App />
 * </RekeyStyles>
 * ```
 *
 * `@rekey.dev/react/styles.css` is the same content as a real file, for a
 * global stylesheet or a CSP that forbids inline `<style>`.
 */
export function RekeyStyles({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <StylesRenderedCtx.Provider value={true}>
      <StyleSheet />
      {children}
    </StylesRenderedCtx.Provider>
  );
}

/** Map appearance variables → inline CSS custom properties. */
export function variablesToStyle(vars: AppearanceVariables | undefined): React.CSSProperties {
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
  // Falls back to `borderRadius`, because that is the only knob the docs have
  // ever taught and every existing integrator sets it alone. Without this,
  // splitting the token silently gave them 12px cards with 2px inputs: a
  // regression produced by an SDK upgrade they did not ask for, in code they
  // did not change. Setting `borderRadiusControl` still wins when they want
  // the two to differ.
  const control = vars.borderRadiusControl ?? vars.borderRadius;
  if (control) s['--rekey-radius-control'] = control;
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
  const stylesAlreadyRendered = React.useContext(StylesRenderedCtx);
  const resolved = normalizeAppearance(appearance);
  const rootClass = ['rekey-root', resolved.elements?.root, className].filter(Boolean).join(' ');
  const mergedStyle: React.CSSProperties = { ...variablesToStyle(resolved.variables), ...style };
  return (
    <AppearanceCtx.Provider value={resolved}>
      <StylesRenderedCtx.Provider value={true}>
        <div
          className={rootClass}
          style={mergedStyle}
          {...(resolved.baseTheme ? { 'data-rekey-theme': resolved.baseTheme } : {})}
        >
          {stylesAlreadyRendered ? null : <StyleSheet />}
          {children}
        </div>
      </StylesRenderedCtx.Provider>
    </AppearanceCtx.Provider>
  );
}
