/**
 * The colours and type of the default emails, derived from a brand.
 *
 * The operator picks one colour. Everything that has to stay readable (the
 * button label, links on white, links on the dark card) is chosen against it
 * by contrast, so a very light or very dark brand colour never produces grey
 * text on grey.
 */

import { contrast, type EmailBrand } from './brand.js';

export const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif,'Apple Color Emoji','Segoe UI Emoji'";
export const MONO_STACK = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
export const CONTENT_WIDTH = 600;

const LIGHT = {
  canvas: '#f4f4f5',
  card: '#ffffff',
  border: '#e4e4e7',
  text: '#18181b',
  body: '#3f3f46',
  muted: '#71717a',
  panel: '#fafafa',
} as const;

const DARK = {
  canvas: '#0b0b0d',
  card: '#18181b',
  border: '#2e2e33',
  text: '#f4f4f5',
  body: '#d4d4d8',
  muted: '#a1a1aa',
  panel: '#1f1f23',
} as const;

const WHITE = '#ffffff';
const INK = '#18181b';
const AA_TEXT = 4.5;
const AA_UI = 3;

export interface Theme {
  light: typeof LIGHT;
  dark: typeof DARK;
  accent: string;
  accentText: string;
  link: string;
  darkLink: string;
  darkButton: string;
  darkButtonText: string;
}

/**
 * @example
 * themeFor(SYSTEM_BRAND).accentText; // '#ffffff'
 */
export function themeFor(brand: EmailBrand): Theme {
  const accent = brand.accent;
  const accentText = contrast(accent, WHITE) >= contrast(accent, INK) ? WHITE : INK;
  const readableOnDark = contrast(accent, DARK.card) >= AA_UI;
  return {
    light: LIGHT,
    dark: DARK,
    accent,
    accentText,
    link: contrast(accent, LIGHT.card) >= AA_TEXT ? accent : LIGHT.text,
    darkLink: contrast(accent, DARK.card) >= AA_TEXT ? accent : DARK.text,
    darkButton: readableOnDark ? accent : DARK.text,
    darkButtonText: readableOnDark ? accentText : INK,
  };
}
