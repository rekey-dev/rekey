/**
 * Guard: the end-user support actions that live on the Overview tab report
 * what they did.
 *
 * "Send password reset" sent the reset, recorded
 * `end_user.password_reset_sent`, and then told the operator nothing at all:
 * the dialog stayed open, the URL never changed, no banner, no error. The
 * action redirects to the same path with `?support=reset-sent`, and on a
 * production build that navigation is not committed here (rekey issue #569,
 * still open). A support action that reads as a no-op is worse than a slow
 * one: the operator sends a second reset, or tells the customer it is broken.
 *
 * The cause turned out to be a React transition left suspended after the
 * payload arrived (`lib/commit-nudge.ts`), which `ActionForm` now nudges
 * through, so the redirect commits and its `?support=` flag is what renders the
 * banner. The two Overview forms used to reload the whole document instead;
 * that reload is gone. The outcome still also waits in a short-lived httpOnly
 * cookie, so a manual reload straight after shows it too.
 *
 * A source scan, for the same reason `action-form.test.ts` is one: it only
 * reproduces on a production build.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankBlockComments } from './action-form.test';

const here = path.dirname(fileURLToPath(import.meta.url));
const euDir = path.join(
  here,
  '..',
  'src',
  'app',
  '(authed)',
  'applications',
  '[id]',
  'end-users',
  '[euid]',
);
const overview = path.join(euDir, 'page.tsx');
const actions = path.join(euDir, 'actions.ts');
const shared = path.join(euDir, 'shared.ts');

/**
 * The Overview support actions: the ones whose result is rendered by the tab
 * they were submitted from, so nothing else navigates and the redirect is the
 * only thing that could have delivered the answer.
 */
const OVERVIEW_ACTIONS = ['sendPasswordReset', 'sendVerification'];

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

describe('end-user support actions say what they did', () => {
  const heads = actionFormHeads(readFileSync(overview, 'utf8'));

  for (const name of OVERVIEW_ACTIONS) {
    it(`${name} is submitted through ActionForm, which gets its redirect committed`, () => {
      const head = heads.find((h) => h.includes(name));
      expect(head, `no <ActionForm> bound to ${name} on the end-user Overview tab`).toBeDefined();
    });
  }

  it('the outcome travels in a cookie, not only in the redirect', () => {
    const source = blankBlockComments(readFileSync(actions, 'utf8'));
    for (const half of ['{ done }', '{ error:']) {
      expect(
        source.includes(`supportFlash(applicationId, euid, tab, ${half}`) ||
          source.includes(`supportFlash(applicationId, euid, '', ${half}`),
        `supportAction must leave its ${half.includes('error') ? 'refusal' : 'result'} in the flash cookie before redirecting, or the reload that follows has nothing to render.`,
      ).toBe(true);
    }
    expect(
      /readSupportFlash/.test(blankBlockComments(readFileSync(shared, 'utf8'))),
      'shared.ts must expose readSupportFlash for the Overview tab to read the flash back.',
    ).toBe(true);
  });

  it('the Overview tab prefers the URL and falls back to the cookie', () => {
    const source = blankBlockComments(readFileSync(overview, 'utf8'));
    expect(
      /const\s+done\s*=[^;]*sp\.support[^;]*flash\.done/.test(source),
      'Overview must read `support` from the query first and the flash cookie second. Reading only the query is the bug; reading only the cookie would show a stale banner to an operator who navigated here by hand.',
    ).toBe(true);
    expect(
      /const\s+supportError\s*=[^;]*sp\.supportError[^;]*flash\.error/.test(source),
      'The refusal needs the same fallback as the success, or a refused support action is the silent one instead.',
    ).toBe(true);
  });
});
