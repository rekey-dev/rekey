import { z } from 'zod';

/**
 * The platform a session was started from. `web` is any browser, `server` a
 * backend runtime with no visitor User-Agent forwarded, `mcp` an agent at the
 * Application's MCP endpoint.
 */
export const CLIENT_PLATFORMS = ['web', 'ios', 'android', 'macos', 'windows', 'linux', 'server', 'mcp', 'other'] as const;
export type ClientPlatform = (typeof CLIENT_PLATFORMS)[number];

/**
 * The optional `client` object on the session-minting routes (sign-up,
 * sign-in, MFA verify, magic-link verify, passkey complete, OAuth callback). A
 * native app says what it is here, since its User-Agent usually does not. It
 * wins over whatever the User-Agent suggests.
 *
 * @example
 *   { email, password, client: { platform: 'ios', appVersion: '4.2.0' } }
 */
export const ClientHintSchema = z.object({
  platform: z.enum(CLIENT_PLATFORMS).optional(),
  /** Your app's version string, shown beside the session: 1-32 letters, digits and `_ . + -`. */
  appVersion: z
    .string()
    .regex(/^[\w.+-]{1,32}$/, 'Use 1-32 letters, digits, underscores, dots, plus or minus signs.')
    .optional(),
});
export type ClientHint = z.infer<typeof ClientHintSchema>;

/** The operating systems the User-Agent reader names. Anything else is null. */
export const CLIENT_OS = ['Windows', 'iOS', 'Android', 'macOS', 'Linux'] as const;
export type ClientOs = (typeof CLIENT_OS)[number];

/** The browsers the User-Agent reader names. Anything else is null. */
export const CLIENT_BROWSERS = ['Edge', 'Opera', 'Firefox', 'Chrome', 'Safari'] as const;
export type ClientBrowser = (typeof CLIENT_BROWSERS)[number];

export interface DescribedClient {
  platform: ClientPlatform;
  os: ClientOs | null;
  browser: ClientBrowser | null;
}

const SERVER_RUNTIME = /^(node|undici|next|node-fetch|axios|python-requests|python-httpx|curl|go-http-client|deno|bun)\b/i;

const PLATFORM_BY_OS: Record<string, ClientPlatform> = {
  Windows: 'windows',
  iOS: 'ios',
  Android: 'android',
  macOS: 'macos',
  Linux: 'linux',
};

/**
 * Read a User-Agent into a platform, an OS and a browser. The one parser for
 * the API (session rows) and the panel (operator sessions).
 *
 * @example
 *   describeClientUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) ... Chrome/126.0 Safari/537.36')
 *   // { platform: 'web', os: 'macOS', browser: 'Chrome' }
 */
export function describeClientUserAgent(ua: string | null | undefined): DescribedClient {
  const raw = (ua ?? '').trim();
  if (raw === '') return { platform: 'other', os: null, browser: null };
  if (SERVER_RUNTIME.test(raw)) return { platform: 'server', os: null, browser: null };

  const os: ClientOs | null = /Windows NT/i.test(raw)
    ? 'Windows'
    : /iPhone|iPad|iOS/i.test(raw)
      ? 'iOS'
      : /Android/i.test(raw)
        ? 'Android'
        : /Mac OS X|Macintosh/i.test(raw)
          ? 'macOS'
          : /Linux/i.test(raw)
            ? 'Linux'
            : null;

  // Order matters: Edge and Chrome both claim "Chrome"; Safari is claimed by
  // everything Chromium.
  const browser: ClientBrowser | null = /Edg\//i.test(raw)
    ? 'Edge'
    : /OPR\/|Opera/i.test(raw)
      ? 'Opera'
      : /Firefox\//i.test(raw)
        ? 'Firefox'
        : /Chrome\//i.test(raw)
          ? 'Chrome'
          : /Safari\//i.test(raw)
            ? 'Safari'
            : null;

  const platform: ClientPlatform = browser ? 'web' : os ? PLATFORM_BY_OS[os]! : 'other';
  return { platform, os, browser };
}
