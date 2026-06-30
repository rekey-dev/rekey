'use client';

/**
 * Light / dark / system theme switcher. Cycles on click; persists the choice in
 * localStorage and applies a `.dark` class to <html> (tailwind darkMode:'class'
 * + the .dark CSS vars in globals.css). "system" follows the OS and live-updates
 * when the OS preference changes. The initial class is set by an inline script
 * in the root layout (THEME_INIT) so there's no flash before this mounts.
 */

import * as React from 'react';

export type Theme = 'light' | 'dark' | 'system';
export const THEME_KEY = 'relipay-theme';

/** Inline-script body for the root layout — runs before paint to avoid FOUC. */
export const THEME_INIT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;

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

export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = React.useState<Theme>('system');
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    const stored = (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system';
    setTheme(stored);
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!mounted) return;
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      if (((localStorage.getItem(THEME_KEY) as Theme | null) ?? 'system') === 'system') applyTheme('system');
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, mounted]);

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

  // Avoid a hydration mismatch on the label (server can't know localStorage).
  const label = mounted ? LABEL[theme] : 'Theme';

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${label} (click to change)`}
      aria-label={`Switch theme — currently ${label}`}
      className="inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
    >
      {ICON[theme]}
      {label}
    </button>
  );
}
