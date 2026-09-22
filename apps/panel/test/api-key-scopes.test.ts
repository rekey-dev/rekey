/**
 * What the API key form sends as `scopes`. Elevated scopes are never part of
 * Full access, so they are added on top of the standard choice, or sent alone
 * for a grant-only key.
 */

import { describe, expect, it } from 'vitest';
import { keyScopesFromForm } from '../src/lib/api-key-scopes';

const base = { fullAccess: false, picked: [] as string[], elevated: [] as string[], elevatedOnly: false };

describe('keyScopesFromForm', () => {
  it('sends nothing (the API default, "*") for full access with no elevated scope', () => {
    expect(keyScopesFromForm({ ...base, fullAccess: true })).toBeUndefined();
    expect(keyScopesFromForm(base)).toBeUndefined();
  });

  it('sends the narrow list when full access is off', () => {
    expect(keyScopesFromForm({ ...base, picked: ['billing:read'] })).toEqual(['billing:read']);
  });

  it('adds an elevated scope on top of full access or a narrow list', () => {
    expect(keyScopesFromForm({ ...base, fullAccess: true, elevated: ['credits:grant'] })).toEqual(['*', 'credits:grant']);
    expect(keyScopesFromForm({ ...base, picked: ['billing:read'], elevated: ['credits:grant'] })).toEqual([
      'billing:read',
      'credits:grant',
    ]);
  });

  it('mints a grant-only key with "Nothing else"', () => {
    expect(
      keyScopesFromForm({ ...base, fullAccess: true, elevated: ['credits:grant'], elevatedOnly: true }),
    ).toEqual(['credits:grant']);
  });

  it('"Nothing else" with no elevated scope ticked does not produce an empty key', () => {
    expect(keyScopesFromForm({ ...base, fullAccess: true, elevatedOnly: true })).toBeUndefined();
  });

  it('drops strings that are not scopes', () => {
    expect(keyScopesFromForm({ ...base, picked: ['billing:reed'], elevated: ['credits:grnt'] })).toBeUndefined();
  });
});
