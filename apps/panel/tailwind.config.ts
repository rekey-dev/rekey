import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // Class-based dark mode so the ThemeToggle (.dark on <html>) drives both the
  // `dark:` utilities and the .dark CSS-var overrides in globals.css.
  darkMode: 'class',
  theme: { extend: {} },
  plugins: [],
};
export default config;
