'use client';

/**
 * Light / dark / system theme switcher. Cycles on click; persists the choice in
 * localStorage and applies a `.dark` class to <html> (tailwind darkMode:'class'
 * + the .dark CSS vars in globals.css). "system" follows the OS and live-updates
 * when the OS preference changes. The initial class, and the listener that
 * follows the OS, come from an inline script in the root layout (THEME_INIT),
 * so they work before and without this button being mounted.
 */

import * as React from 'react';

export type Theme = 'light' | 'dark' | 'system';
export const THEME_KEY = 'rekey-theme';

/**
 * Inline-script body for the root layout. Runs before paint to avoid FOUC, and
 * keeps "system" following the OS for the life of the page.
 */
export const THEME_INIT = `(function(){try{var q=window.matchMedia('(prefers-color-scheme: dark)');var a=function(){var t=localStorage.getItem('${THEME_KEY}')||'system';document.documentElement.classList.toggle('dark',t==='dark'||(t==='system'&&q.matches));};a();q.addEventListener('change',a);}catch(e){}})();`;

function applyTheme(theme: Theme): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

const ICON: Record<Theme, React.JSX.Element> = {
  light: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  dark: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  ),
  system: (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  ),
};
const LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' };
const NEXT: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' };

function storedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Client-only: it lives in the account menu, which never server-renders open. */
export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = React.useState<Theme>(storedTheme);

  function cycle(): void {
    const next = NEXT[theme];
    setTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
    applyTheme(next);
  }

  const label = LABEL[theme];

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${label} (click to change)`}
      aria-label={`Switch theme, currently ${label}`}
      className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
    >
      {ICON[theme]}
      {label}
    </button>
  );
}
