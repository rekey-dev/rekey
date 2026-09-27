/**
 * Whose name is on a default email.
 *
 * An end user who asked to reset their password knows the Application, not
 * Rekey, so the defaults wear the Application's own branding: the portal
 * branding an operator already set (display name, logo, primary colour,
 * support contact), falling back to the Application's name. Mail Rekey sends
 * to operators about their workspace wears {@link SYSTEM_BRAND}.
 *
 * Every value here is written into a template BEFORE `{{var}}` substitution,
 * so none of them may contain a brace: an Application named `{{resetUrl}}`
 * would otherwise be read as a token.
 */

import type { Application } from '@prisma/client';
import { safeColor, safeEmail, safeText, safeUrl } from '../../../lib/branding.js';

export interface EmailBrand {
  name: string;
  logoUrl: string | null;
  /** A `#rrggbb` colour, already validated. */
  accent: string;
  supportEmail: string | null;
  supportUrl: string | null;
  /** Ends end-user mail with "Secured by Rekey" (the workspace's `emailAttribution`). */
  attribution: boolean;
}

export const NEUTRAL_ACCENT = '#18181b';

export const SYSTEM_BRAND: EmailBrand = {
  name: 'Rekey',
  logoUrl: null,
  accent: NEUTRAL_ACCENT,
  supportEmail: null,
  supportUrl: null,
  attribution: false,
};

const BRACES = /[{}]/g;

/**
 * Expand `#abc` to `#aabbcc`. The alpha forms are dropped: a translucent
 * button colour reads differently on every client background.
 */
function sixDigitHex(color: string | null): string | null {
  if (color === null) return null;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null;
}

function withoutBraces(url: string | null): string | null {
  return url === null ? null : url.replace(/\{/g, '%7B').replace(/\}/g, '%7D');
}

/**
 * The brand an Application's default emails carry.
 *
 * The support contact is the sender identity's `supportEmail` when set, then
 * the portal branding's `supportEmail`, then none (`supportUrl` still shows
 * when that is set). Both go through `safeEmail`.
 *
 * @example
 * brandFromApplication({ name: 'Acme', portalBranding: { primaryColor: '#e11d48' } });
 * // { name: 'Acme', accent: '#e11d48', logoUrl: null, ... }
 */
export function brandFromApplication(
  app: Pick<Application, 'name' | 'portalBranding'> & Partial<Pick<Application, 'emailConfig'>>,
  options: { attribution?: boolean } = {},
): EmailBrand {
  const b = (app.portalBranding ?? {}) as Record<string, unknown>;
  const sender = (app.emailConfig ?? {}) as Record<string, unknown>;
  const name =
    (safeText(b.displayName, 80) ?? safeText(app.name, 80) ?? '').replace(BRACES, '').trim() ||
    'Your account';
  return {
    name,
    logoUrl: withoutBraces(safeUrl(b.logoUrl, true)),
    accent: sixDigitHex(safeColor(b.primaryColor)) ?? NEUTRAL_ACCENT,
    supportEmail: safeEmail(sender.supportEmail) ?? safeEmail(b.supportEmail),
    supportUrl: withoutBraces(safeUrl(b.supportUrl, false)),
    attribution: options.attribution === true,
  };
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * WCAG contrast ratio between two `#rrggbb` colours.
 *
 * @example
 * contrast('#ffffff', '#000000'); // 21
 */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
