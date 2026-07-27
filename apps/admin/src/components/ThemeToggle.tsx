'use client';

import * as React from 'react';

/**
 * Pre-paint theme init script — runs in <head> before React mounts so the
 * <html> class is correct on first paint (no light/dark flash). Mirrors the
 * panel's ThemeToggle pattern (see apps/panel/src/components/ThemeToggle.tsx).
 *
 * Three states: 'light' | 'dark' | 'system'. 'system' resolves via matchMedia.
 */
export const THEME_INIT = `
(function(){try{
  var saved = localStorage.getItem('rekey-admin-theme') || 'system';
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var dark = saved === 'dark' || (saved === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}catch(e){}})();
`;

type Mode = 'light' | 'dark' | 'system';

function applyMode(mode: Mode): void {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = mode === 'dark' || (mode === 'system' && prefersDark);
  document.documentElement.classList.toggle('dark', dark);
}

export function ThemeToggle(): React.JSX.Element {
  const [mode, setMode] = React.useState<Mode>('system');

  React.useEffect(() => {
    const saved = (localStorage.getItem('rekey-admin-theme') as Mode | null) ?? 'system';
    setMode(saved);
  }, []);

  function pick(next: Mode): void {
    setMode(next);
    localStorage.setItem('rekey-admin-theme', next);
    applyMode(next);
  }

  const ariaLabels: Record<Mode, string> = {
    light: 'Light theme',
    system: 'Match system theme',
    dark: 'Dark theme',
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-0.5"
    >
      {(['light', 'system', 'dark'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          onClick={() => pick(m)}
          aria-checked={mode === m}
          aria-label={ariaLabels[m]}
          className={
            'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ' +
            (mode === m
              ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
              : 'text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]')
          }
          title={ariaLabels[m]}
        >
          <span aria-hidden="true">{m === 'light' ? '☀' : m === 'dark' ? '☾' : '◑'}</span>
        </button>
      ))}
    </div>
  );
}
