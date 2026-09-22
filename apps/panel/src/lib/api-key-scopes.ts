import { ELEVATED_API_KEY_SCOPES, STANDARD_API_KEY_SCOPES } from '@rekey.dev/shared-types';

/**
 * The `scopes` the mint form sends, from what the operator ticked.
 *
 * `undefined` means "send no scopes field", which the API turns into `["*"]`.
 * Elevated scopes are never part of `*`, so they are added on top of whichever
 * standard choice was made, or, with `elevatedOnly`, sent alone: a key that can
 * grant credits and do nothing else.
 */
export function keyScopesFromForm(input: {
  fullAccess: boolean;
  picked: readonly string[];
  elevated: readonly string[];
  elevatedOnly: boolean;
}): string[] | undefined {
  const picked = input.picked.filter((s) => (STANDARD_API_KEY_SCOPES as readonly string[]).includes(s));
  const elevated = input.elevated.filter((s) => (ELEVATED_API_KEY_SCOPES as readonly string[]).includes(s));
  const standard = input.fullAccess || picked.length === 0 ? undefined : picked;
  if (elevated.length === 0) return standard;
  if (input.elevatedOnly) return elevated;
  return [...(standard ?? ['*']), ...elevated];
}
