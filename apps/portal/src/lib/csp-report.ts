/**
 * Reduce a browser's CSP violation report to what an operator needs to see:
 * which directive blocked which origin, on which page origin. Paths are
 * dropped from both URLs because a checkout page's path carries its token.
 */

export interface CspReportSummary {
  directive: string;
  blocked: string;
  page: string;
}

function originOnly(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  try {
    return new URL(value).origin;
  } catch {
    // `inline`, `eval` and similar keywords are not URLs and carry no token.
    return value.slice(0, 40);
  }
}

/**
 * @example
 * summariseCspReport('{"csp-report":{"violated-directive":"script-src","blocked-uri":"https://evil.example/x.js","document-uri":"https://portal/acme/checkout/chk_live_…"}}');
 * // { directive: 'script-src', blocked: 'https://evil.example', page: 'https://portal' }
 */
export function summariseCspReport(body: string): CspReportSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const report = (parsed as { 'csp-report'?: Record<string, unknown> } | null)?.['csp-report'];
  if (!report || typeof report !== 'object') return null;
  return {
    directive: String(report['effective-directive'] ?? report['violated-directive'] ?? 'unknown').slice(0, 60),
    blocked: originOnly(report['blocked-uri']),
    page: originOnly(report['document-uri']),
  };
}
