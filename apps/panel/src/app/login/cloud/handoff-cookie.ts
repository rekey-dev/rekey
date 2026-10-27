import { cookieSecure } from '@/lib/cookie-secure';

/**
 * A Cloud handoff held for the operator to confirm. The ID Token is a bearer
 * assertion, so it waits in an httpOnly cookie scoped to the handoff paths,
 * never in a URL, and lives no longer than the token itself does at the API.
 */
export const CLOUD_HANDOFF_COOKIE = 'rk_cloud_handoff';
export const CLOUD_HANDOFF_CONFIRM_PATH = '/login/cloud/confirm';
const CLOUD_HANDOFF_COOKIE_PATH = '/login/cloud';
const CLOUD_HANDOFF_MAX_AGE_SECONDS = 5 * 60;

interface HandoffCookieSink {
  set(
    name: string,
    value: string,
    options: { httpOnly: true; sameSite: 'lax'; secure: boolean; path: string; maxAge: number },
  ): unknown;
}

/**
 * `lax` because the confirm page is reached by the redirect of a cross-site
 * POST, a top-level GET that `strict` would send no cookie on.
 *
 * @example
 * await writeCloudHandoff(res.cookies, idToken);
 */
export async function writeCloudHandoff(jar: HandoffCookieSink, idToken: string): Promise<void> {
  jar.set(CLOUD_HANDOFF_COOKIE, idToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: await cookieSecure(),
    path: CLOUD_HANDOFF_COOKIE_PATH,
    maxAge: CLOUD_HANDOFF_MAX_AGE_SECONDS,
  });
}

/**
 * @example
 * clearCloudHandoff(await cookies());
 */
export function clearCloudHandoff(jar: { delete(options: { name: string; path: string }): unknown }): void {
  jar.delete({ name: CLOUD_HANDOFF_COOKIE, path: CLOUD_HANDOFF_COOKIE_PATH });
}

/**
 * The `email` claim, read unverified and used only to show the operator which
 * account they would switch to. The API verifies the token when it is spent.
 *
 * @example
 * handoffEmail(idToken); // 'buyer@example.com', or null when absent
 */
export function handoffEmail(idToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof payload.email === 'string' && payload.email ? payload.email : null;
  } catch {
    return null;
  }
}
