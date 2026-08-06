/**
 * Write dist/styles.css from the same constant the components render.
 *
 * Two copies of a stylesheet drift, so there is only one: `STYLES` in
 * theme.tsx. This emits it as a real file for consumers who cannot use the
 * rendered version — a strict CSP that forbids inline styles, a framework
 * that wants one global stylesheet, anyone rendering the components without
 * React on the client.
 */
import { writeFileSync } from 'node:fs';
import { STYLES } from '../dist/theme.js';

const header = `/* Generated from src/theme.tsx — do not edit.\n   Same rules the components render inline; link this instead if you prefer. */\n`;
writeFileSync(new URL('../dist/styles.css', import.meta.url), header + STYLES.trimStart());
console.log('wrote dist/styles.css');
