/**
 * Format helpers — kept tiny and dependency-free. Tailwind handles styling;
 * this module just turns server data into display strings.
 */

/**
 * Format an integer amount in the smallest currency unit as a human price
 * string. e.g. (999, 'USD') → '$9.99'. Uses Intl.NumberFormat for locale
 * decimals — the panel runs server-side, so the locale is the server's.
 */
export function formatMoney(amount: number, currency: string): string {
  // Most non-zero-decimal currencies are two-decimal; we hard-code that
  // for the MVP. JPY/KRW/etc. are zero-decimal — future improvement is
  // a lookup table or use the runtime locale's currency formatter.
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

export function formatPercent(basisPointsTimesTen: number): string {
  return `${(basisPointsTimesTen / 100).toFixed(2)}%`;
}

/** What `describeUserAgent` decided a session actually is. */
export interface DescribedUserAgent {
  /** Human label for the device row. */
  label: string;
  /**
   * Set when the row is NOT a device the operator owns — i.e. the panel's own
   * server-side fetch. The sessions list tells people to "revoke any you don't
   * recognize", so an unexplained `node` row invites them to revoke their own
   * working session.
   */
  note?: string;
}

/**
 * Turn a raw User-Agent into something an operator can act on.
 *
 * The one that matters is bare `node`/`undici`/`next` — that is the PANEL
 * itself calling the API server-side on the operator's behalf, not a second
 * machine someone signed in from. It looked identical to a real device on a
 * page whose instruction is "revoke any you don't recognize".
 */
export function describeUserAgent(ua: string | null): DescribedUserAgent {
  const raw = (ua ?? '').trim();
  if (raw === '') return { label: 'Unknown device' };

  // Server-side runtimes. Node's default fetch UA is literally `node`; undici
  // and Next's server fetch identify similarly.
  if (/^(node|undici|next)\b/i.test(raw) || /^node-fetch/i.test(raw)) {
    return {
      label: 'Rekey panel (server-side)',
      note: 'This is the panel itself calling the API for you, not another device. Revoking it signs you out of the panel.',
    };
  }

  const os = /Windows NT/i.test(raw)
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
  const browser = /Edg\//i.test(raw)
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

  if (browser && os) return { label: `${browser} on ${os}` };
  if (browser) return { label: browser };
  if (os) return { label: os };
  // Unrecognised: show it, truncated, rather than inventing a label.
  return { label: raw.length > 60 ? `${raw.slice(0, 57)}…` : raw };
}
