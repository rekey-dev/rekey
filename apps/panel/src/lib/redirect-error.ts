/**
 * Detect Next.js's internal redirect signal.
 *
 * `redirect()` (and `notFound()`) work by THROWING a control-flow error whose
 * `digest` starts with `NEXT_REDIRECT`. When a client component `await`s a
 * server action that redirects, that error surfaces in the caller's `catch`.
 * If the catch treats it as a real failure (e.g. `setError(e.message)`), the UI
 * briefly flashes "NEXT_REDIRECT" before the navigation lands. Re-throw it
 * instead so Next completes the redirect.
 */
export function isRedirectError(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'digest' in e &&
    typeof (e as { digest?: unknown }).digest === 'string' &&
    ((e as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
      (e as { digest: string }).digest === 'NEXT_NOT_FOUND')
  );
}
