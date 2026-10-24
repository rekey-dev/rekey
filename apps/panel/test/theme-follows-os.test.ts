// @vitest-environment jsdom
/**
 * "System" must keep following the OS after the theme button unmounts: it now
 * lives in a menu that is closed most of the time, so the listener sits in the
 * root layout's inline script.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_INIT, THEME_KEY } from '../src/components/ThemeToggle';

function fakeOs(dark: boolean): { flip: (next: boolean) => void } {
  const listeners: Array<() => void> = [];
  const mq = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
  };
  vi.stubGlobal('matchMedia', () => mq);
  return {
    flip(next) {
      mq.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

describe('THEME_INIT', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('follows the OS while the stored theme is system', () => {
    const os = fakeOs(false);
    new Function(THEME_INIT)();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    os.flip(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('ignores the OS once a theme is chosen', () => {
    localStorage.setItem(THEME_KEY, 'light');
    const os = fakeOs(false);
    new Function(THEME_INIT)();
    os.flip(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
