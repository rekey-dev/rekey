'use client';

/**
 * Command palette (Cmd+K / Ctrl+K) — a client island mounted once in the
 * authed layout.
 *
 * Built on the same native `<dialog>` patterns as Modal.tsx (showModal() for
 * the focus trap + Esc-to-close, backdrop click via `e.target ===
 * e.currentTarget`) but with combobox semantics instead of a form body, so it
 * isn't a Modal reuse — Modal's trigger/title anatomy doesn't fit a palette.
 *
 * Sources:
 *  1. Static workspace nav destinations (mirrors Sidebar's NAV).
 *  2. The operator's applications — fetched once per page load when the
 *     palette first opens, via the panel's own /api/palette/applications
 *     proxy (the operator JWT lives in httpOnly cookies; see that route).
 *  3. Section jumps for the *current* application when the route is under
 *     /applications/{id} (mirrors AppNav's groups, flattened; billing
 *     sections are gated on the app's billingConfig.enabled).
 *
 * Filtering is a case-insensitive includes-then-subsequence match. Keyboard:
 * arrows + Enter, Home/End. A11y: role="combobox" input controlling a
 * role="listbox" with aria-activedescendant. Recent selections persist in
 * localStorage and surface on top when the query is empty.
 *
 * Other components (e.g. the Sidebar search button) open the palette by
 * dispatching OPEN_COMMAND_PALETTE_EVENT on `window`.
 */

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';

export const OPEN_COMMAND_PALETTE_EVENT = 'relipay:open-command-palette';

/** Convenience for client components that want a "Search" button. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT));
}

const RECENTS_KEY = 'relipay.palette.recents';
const RECENTS_MAX = 5;

interface PaletteApp {
  id: string;
  name: string;
  slug: string;
  billingEnabled: boolean;
}

interface PaletteItem {
  /** Stable unique id — doubles as the React key + aria option id suffix. */
  id: string;
  label: string;
  /** Secondary text rendered after the label (e.g. an app slug). */
  hint?: string;
  group: string;
  href: string;
  /** Extra strings the filter matches against. */
  keywords?: string;
}

/** Mirrors Sidebar's NAV — keep in sync when nav entries change. */
const NAV_DESTINATIONS: Array<{ label: string; href: string; keywords?: string }> = [
  { label: 'Applications', href: '/applications', keywords: 'apps' },
  { label: 'Team', href: '/team', keywords: 'members invitations invite' },
  { label: 'Workspace settings', href: '/workspace', keywords: 'settings tenant workspace' },
  { label: 'Audit log', href: '/audit-log', keywords: 'security events export' },
  { label: 'Email logs', href: '/email-logs', keywords: 'mail delivery' },
  { label: 'Account security', href: '/account/security', keywords: 'account security mfa password sessions passkeys' },
  { label: 'API tokens', href: '/account/api-tokens', keywords: 'account keys personal' },
  { label: 'Operator MCP', href: '/account/mcp', keywords: 'account model context protocol ai agents' },
  { label: 'My requests', href: '/account/activity', keywords: 'account activity log' },
];

/** Mirrors AppNav's groups, flattened. `billing: true` rows are gated. */
const APP_SECTIONS: Array<{ seg: string; label: string; billing?: boolean; keywords?: string }> = [
  { seg: '', label: 'Overview', keywords: 'dashboard stats' },
  { seg: 'end-users', label: 'End-users', keywords: 'users customers' },
  { seg: 'organizations', label: 'Organizations', keywords: 'orgs teams' },
  { seg: 'activity', label: 'Activity', keywords: 'security events' },
  { seg: 'auth', label: 'Auth methods', keywords: 'authentication password sign-in mfa' },
  { seg: 'oauth', label: 'OAuth', keywords: 'google microsoft providers social' },
  { seg: 'mcp', label: 'MCP', keywords: 'model context protocol' },
  { seg: 'revenue', label: 'Revenue', billing: true, keywords: 'billing overview mrr chart' },
  { seg: 'billing', label: 'Billing providers', billing: true, keywords: 'stripe paypal razorpay credentials' },
  { seg: 'plans', label: 'Plans', billing: true, keywords: 'pricing billing subscription' },
  { seg: 'payments', label: 'Payments', billing: true, keywords: 'billing charges refunds' },
  { seg: 'coupons', label: 'Coupons', billing: true, keywords: 'discounts billing promo' },
  { seg: 'licenses', label: 'Licenses', billing: true, keywords: 'keys seats billing' },
  { seg: 'usage', label: 'Usage', billing: true, keywords: 'meters credits billing' },
  { seg: 'api-keys', label: 'API keys', keywords: 'developer secret keys' },
  { seg: 'webhooks', label: 'Webhooks', keywords: 'developer endpoints deliveries events' },
  { seg: 'requests', label: 'Requests', keywords: 'developer request logs' },
  { seg: 'access', label: 'Access', keywords: 'developer ip allowlist cors' },
  { seg: 'email', label: 'Email', keywords: 'developer templates smtp resend' },
];

/** Case-insensitive includes, falling back to in-order subsequence. */
function fuzzyMatch(query: string, text: string): boolean {
  if (text.includes(query)) return true;
  let qi = 0;
  for (let ti = 0; ti < text.length && qi < query.length; ti++) {
    if (text[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}

function itemMatches(query: string, item: PaletteItem): boolean {
  const haystack = `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''}`.toLowerCase();
  return fuzzyMatch(query, haystack);
}

function readRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function CommandPalette(): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [apps, setApps] = React.useState<PaletteApp[] | null>(null);
  const [recents, setRecents] = React.useState<string[]>([]);

  // Global shortcut + the custom open event (Sidebar search button).
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpenEvent(): void {
      setOpen(true);
    }
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  // Drive the native <dialog> from React state. showModal() gives us the
  // focus trap + Esc; the dialog's onClose keeps state in sync either way.
  React.useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery('');
      setActiveIndex(0);
      setRecents(readRecents());
      try {
        dialog.showModal();
      } catch {
        /* already open / detached — ignore (same rationale as Modal.tsx) */
      }
      // showModal focuses the dialog; move it into the input.
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Fetch the application list once per page load, lazily on first open.
  const fetchedRef = React.useRef(false);
  React.useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    fetch('/api/palette/applications', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<PaletteApp[]>) : []))
      .then((list) => setApps(Array.isArray(list) ? list : []))
      .catch(() => setApps([]));
  }, [open]);

  // Current application context (when on /applications/{id}/...).
  const appIdMatch = /^\/applications\/([^/]+)/.exec(pathname);
  const currentAppId = appIdMatch?.[1];
  const currentApp = currentAppId ? apps?.find((a) => a.id === currentAppId) : undefined;

  const items = React.useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    if (currentAppId) {
      const base = `/applications/${currentAppId}`;
      const group = currentApp ? `Current app — ${currentApp.name}` : 'Current app';
      for (const s of APP_SECTIONS) {
        // Billing sections are server-gated when billing is disabled — don't
        // offer dead links. (When the list hasn't loaded yet we can't know;
        // omit until it has.)
        if (s.billing && !currentApp?.billingEnabled) continue;
        out.push({
          id: `section:${s.seg || 'overview'}`,
          label: s.label,
          group,
          href: s.seg ? `${base}/${s.seg}` : base,
          keywords: s.keywords,
        });
      }
    }
    for (const n of NAV_DESTINATIONS) {
      out.push({ id: `nav:${n.href}`, label: n.label, group: 'Workspace', href: n.href, keywords: n.keywords });
    }
    for (const a of apps ?? []) {
      out.push({
        id: `app:${a.id}`,
        label: a.name,
        hint: a.slug,
        group: 'Applications',
        href: `/applications/${a.id}`,
        keywords: a.slug,
      });
    }
    return out;
  }, [apps, currentAppId, currentApp]);

  const filtered = React.useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const recentItems = recents
        .map((href) => items.find((i) => i.href === href))
        .filter((i): i is PaletteItem => i !== undefined)
        .map((i) => ({ ...i, id: `recent:${i.id}`, group: 'Recent' }));
      return [...recentItems, ...items];
    }
    // Keep source order (group-clustered) so group headers don't interleave.
    return items.filter((i) => itemMatches(q, i));
  }, [query, items, recents]);

  // Clamp / reset the active row whenever the result set changes.
  React.useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Keep the active option visible while arrowing through a long list.
  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#palette-opt-${activeIndex}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  function select(item: PaletteItem): void {
    try {
      const next = [item.href, ...readRecents().filter((h) => h !== item.href)].slice(0, RECENTS_MAX);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      setRecents(next);
    } catch {
      /* private mode / quota — recents are optional */
    }
    setOpen(false);
    router.push(item.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Home' && filtered.length > 0) {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End' && filtered.length > 0) {
      e.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filtered[activeIndex];
      if (item) select(item);
    }
  }

  const listboxId = 'relipay-palette-listbox';
  const activeOptionId = filtered.length > 0 ? `palette-opt-${activeIndex}` : undefined;

  // Render rows with a group header whenever the group changes (source order
  // is group-clustered, so headers never repeat).
  let lastGroup: string | null = null;

  return (
    <dialog
      ref={dialogRef}
      aria-label="Command palette"
      onClose={() => setOpen(false)}
      onClick={(e) => {
        // Backdrop click → close (same Safari-safe check as Modal.tsx).
        if (e.target === e.currentTarget) setOpen(false);
      }}
      className="w-[90vw] max-w-xl rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-left text-[var(--color-fg)] shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm mt-[12vh] mb-auto"
    >
      <div className="flex items-center gap-2.5 border-b border-[var(--color-border)] px-4">
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="shrink-0 text-[var(--color-faint-fg)]"
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          aria-label="Search pages and applications"
          placeholder="Search pages and applications…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={onInputKeyDown}
          className="w-full bg-transparent py-3 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-faint-fg)] focus:outline-none"
        />
        <kbd className="shrink-0 rounded border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-muted-fg)]">
          Esc
        </kbd>
      </div>

      <ul
        id={listboxId}
        ref={listRef}
        role="listbox"
        aria-label="Results"
        className="max-h-[50vh] overflow-y-auto p-2"
      >
        {filtered.length === 0 && (
          <li role="presentation" className="px-2.5 py-6 text-center text-sm text-[var(--color-muted-fg)]">
            No results for “{query.trim()}”.
          </li>
        )}
        {filtered.map((item, index) => {
          const showHeader = item.group !== lastGroup;
          lastGroup = item.group;
          const active = index === activeIndex;
          return (
            <React.Fragment key={item.id}>
              {showHeader && (
                <li
                  role="presentation"
                  className="px-2.5 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-faint-fg)]"
                >
                  {item.group}
                </li>
              )}
              <li
                id={`palette-opt-${index}`}
                role="option"
                aria-selected={active}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => select(item)}
                className={`flex cursor-pointer items-baseline gap-2 rounded-md px-2.5 py-2 text-sm ${
                  active
                    ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                    : 'text-[var(--color-muted-fg)]'
                }`}
              >
                <span className="truncate font-medium text-[var(--color-fg)]">{item.label}</span>
                {item.hint && (
                  <span className="truncate font-mono text-xs text-[var(--color-muted-fg)]">{item.hint}</span>
                )}
                {active && (
                  <span aria-hidden="true" className="ml-auto shrink-0 text-xs text-[var(--color-faint-fg)]">
                    ↵
                  </span>
                )}
              </li>
            </React.Fragment>
          );
        })}
      </ul>

      <div className="flex items-center gap-3 border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-faint-fg)]">
        <span>↑↓ navigate</span>
        <span>↵ open</span>
        <span>Esc close</span>
      </div>
    </dialog>
  );
}
