/**
 * Guard: minting an API key cannot produce a key whose value is never shown,
 * and the mint modal never reopens onto the previous attempt's name.
 *
 * A secret key is rendered exactly once. That render used to depend on the
 * action's `redirect()` being committed by the client, which on a production
 * build is not something this app can rely on: rekey issue #569 has redirects
 * that are answered, rendered, and then dropped. A dropped one here leaves the
 * operator with a live credential they were never shown, counted against the
 * application's key cap, and only discoverable by reading the list and
 * noticing a key they cannot use.
 *
 * So the mint form reloads the page once the action settles, and everything
 * the next render needs travels in a path-scoped httpOnly cookie rather than
 * the query the reload does not have: the raw key in `rekey_reveal_key`, and
 * a refusal in `rekey_mint_flash`. Without the second one, fixing the reveal
 * would have made every refusal silent instead.
 *
 * The second half is the modal: these dialogs are not unmounted when they
 * close, so the name from the previous attempt was still in the field on
 * reopen and typing went on the end of it, producing key names like
 * "Trial secret keyProduction server".
 *
 * A source scan, for the same reason `action-form.test.ts` is one: it only
 * reproduces on a production build, so a browser test of it would be flaky and
 * a typecheck will never see it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankBlockComments } from './action-form.test';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');
const apiKeysPage = path.join(srcDir, 'app', '(authed)', 'applications', '[id]', 'api-keys', 'page.tsx');
const modal = path.join(srcDir, 'components', 'Modal.tsx');

/** The `<ActionForm …>` opening tags in a file, with comments blanked. */
function actionFormHeads(source: string): string[] {
  const text = blankBlockComments(source);
  const heads: string[] = [];
  for (const match of text.matchAll(/<ActionForm\b/g)) {
    let i = match.index + match[0].length;
    let depth = 0;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    heads.push(text.slice(match.index, i + 1));
  }
  return heads;
}

describe('a minted API key always reaches the operator', () => {
  it('the mint form does not depend on the action redirect being committed', () => {
    const head = actionFormHeads(readFileSync(apiKeysPage, 'utf8')).find((h) =>
      h.includes('createKey'),
    );
    expect(head, 'no <ActionForm> bound to createKey on the API keys page').toBeDefined();
    expect(
      head!.includes('reloadOnSettle'),
      "The mint form must set reloadOnSettle. The raw key is shown exactly once, and without the reload that render depends on the action's redirect being committed, which rekey issue #569 says it may not be. The key is minted either way, so the operator is left holding a credential they were never shown.",
    ).toBe(true);
  });

  it('a refused mint is reported without the query the reload does not have', () => {
    const source = blankBlockComments(readFileSync(apiKeysPage, 'utf8'));
    // Every failure path in createKey leaves the code behind before it
    // redirects, and the page reads it back when the URL carries none.
    const redirectsWithError = [...source.matchAll(/redirect\(`[^`]*\?[^`]*error=/g)].length;
    const flashWrites = [...source.matchAll(/setMintFlash\(/g)].length;
    expect(
      flashWrites >= redirectsWithError,
      `createKey has ${redirectsWithError} redirects carrying an error code but only ${flashWrites} setMintFlash calls (one of which is the success path). After reloadOnSettle the operator lands on a URL with no query, so a refusal that only travels in the redirect is never rendered and the mint looks like it silently did nothing.`,
    ).toBe(true);
    expect(
      /const\s+error\s*=[^;]*mintFlash/.test(source),
      'The page must fall back to the mint flash cookie when the URL carries no error code.',
    ).toBe(true);
  });

  it('opening a modal puts its forms back to the markup they were rendered with', () => {
    const source = blankBlockComments(readFileSync(modal, 'utf8'));
    const open = /function open\(\): void \{([\s\S]*?)\n {2}\}/.exec(source);
    expect(open, 'Modal.open() not found').not.toBeNull();
    expect(
      /resetForms\(\)/.test(open![1]!),
      'Modal.open() must reset the forms inside the dialog. These dialogs are never unmounted, so without it the next operator to open "New API key" is typing on the end of the previous key\'s name.',
    ).toBe(true);
    expect(
      /for \(const form of[\s\S]*?\) form\.reset\(\)/.test(source),
      'resetForms() must call form.reset(), not blank the fields: a modal that reopens on a refusal re-renders the operator\'s values as defaults, and those are meant to survive.',
    ).toBe(true);
  });

});
