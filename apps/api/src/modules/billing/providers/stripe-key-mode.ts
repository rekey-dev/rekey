/**
 * The mode a Stripe key states in its prefix (`pk_`, `sk_` or `rk_`, then
 * `test_` or `live_`), or null for anything else.
 *
 * @example
 * stripeKeyMode('pk_live_123'); // 'live'
 * stripeKeyMode('whsec_123'); // null
 */
export function stripeKeyMode(key: string | undefined): 'test' | 'live' | null {
  const match = /^(?:pk|sk|rk)_(test|live)_/.exec(key ?? '');
  if (!match) return null;
  return match[1] === 'live' ? 'live' : 'test';
}
