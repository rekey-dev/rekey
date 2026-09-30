/**
 * Guard: a credential never travels in a `redirect()` query.
 *
 * The invitation token used to be handed to the next render as
 * `/team?inviteToken=…`. That token joins a workspace, and in the URL it lands
 * in browser history, in the `Referer` of the next outbound link, and in every
 * access log in between.
 *
 * Every one-time secret now goes back in the minting action's own response to
 * the dialog `RevealActionForm` opens (`test/one-time-secret.test.ts` pins
 * that). This file keeps the older, wider rule: whatever an action redirects
 * to, no credential rides in its query.
 *
 * A source scan, for the same reason `action-form.test.ts` is one: the
 * behaviour only reproduces on a production build, so a browser test of it
 * would be flaky and a typecheck will never see it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blankBlockComments } from './action-form.test';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

/**
 * Query parameter names that carry a credential. A redirect target is a URL:
 * whatever is in it is logged, refered and kept in history, so none of these
 * belongs in one. Add a name here when a new secret appears; the fix is always
 * to return it to `RevealActionForm`, never a longer name.
 */
const CREDENTIAL_PARAMS = [
  'inviteToken',
  'token',
  'rawKey',
  'apiKey',
  'secret',
  'password',
  'refreshToken',
  'accessToken',
  'challenge',
  // A workspace-bound operator invite (`rp_opinv_…`): redeeming it joins a
  // workspace, as OWNER when minted by `rekey init`.
  'invite',
];

/**
 * Pages the operator reaches BY a link that already contains the token: the
 * accept-invite landing page, the password reset form, and the sign-up form
 * when accept-invite hands it a workspace-bound operator invite
 * (`/sign-up?invite=rp_opinv_…`). The token is in their URL by construction,
 * put there by the email or the invite link, and these redirects only
 * preserve it across a validation failure so the form still works on the
 * second try. There is nothing to move out of the URL, because the token
 * arrived in it. Anything else that wants to be here is the bug this file is
 * about.
 *
 * Each entry names the parameters it may carry, so allowlisting a page for
 * one credential does not quietly allow every other one.
 */
const ARRIVED_BY_LINK: Readonly<Record<string, readonly string[]>> = {
  [path.join('app', 'accept-invite', 'page.tsx')]: ['token'],
  [path.join('app', 'reset-password', 'page.tsx')]: ['token'],
  [path.join('app', 'sign-up', 'page.tsx')]: ['invite'],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * The argument text of every `redirect(…)` and `seeOther(…)` call in a source
 * file (`seeOther` is the Route Handlers' 303 helper), with its
 * line number. Balanced on parentheses so a target built from
 * `` `…${encodeURIComponent(x)}…` `` is not cut short, and comments are
 * blanked first so a docblock describing the old shape is not scanned.
 */
export function redirectTargets(source: string): { arg: string; line: number }[] {
  const text = blankBlockComments(source).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const found: { arg: string; line: number }[] = [];
  const call = /\b(?:redirect|seeOther)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
    }
    const arg = text.slice(start, i - 1);
    found.push({
      arg: arg + interpolatedInitializers(text, arg),
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

/**
 * The initializer text of every `const` a redirect target interpolates. A
 * query built one line earlier (`const keep = \`&invite=${key}\``) and
 * spliced in as `${keep}` must count as part of the target, or the scan
 * passes by indirection.
 */
function interpolatedInitializers(text: string, arg: string): string {
  let extra = '';
  for (const [, name] of arg.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) {
    const decl = new RegExp(`\\bconst\\s+${name}\\s*=`).exec(text);
    if (!decl) continue;
    const end = text.indexOf(';', decl.index);
    extra += ' ' + text.slice(decl.index, end === -1 ? undefined : end);
  }
  return extra;
}

describe('credentials never ride in a redirect query', () => {
  it('no redirect target in the panel assigns a credential parameter', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      const allowed = ARRIVED_BY_LINK[rel] ?? [];
      const source = readFileSync(file, 'utf8');
      if (!source.includes('redirect(') && !source.includes('seeOther(')) continue;
      for (const { arg, line } of redirectTargets(source)) {
        for (const param of CREDENTIAL_PARAMS.filter((p) => !allowed.includes(p))) {
          // `?token=` / `&token=`, the only way a value reaches a query.
          if (new RegExp(`[?&]${param}=`).test(arg)) {
            offenders.push(
              `${path.relative(srcDir, file)}:${line} redirects with '${param}' in the query: ${arg.trim().slice(0, 120)}`,
            );
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('sees a credential spliced in through a const, not only a literal one', () => {
    const source = [
      'const keep = `&email=${e}&invite=${encodeURIComponent(k)}`;',
      'redirect(`/sign-up?error=missing${keep}`);',
    ].join('\n');
    const [target] = redirectTargets(source);
    expect(target?.arg).toMatch(/[?&]invite=/);
  });

  it('every allowlisted page exists and really does carry its parameter', () => {
    for (const [rel, params] of Object.entries(ARRIVED_BY_LINK)) {
      const source = readFileSync(path.join(srcDir, rel), 'utf8');
      const carried = redirectTargets(source).map((t) => t.arg).join('\n');
      for (const param of params) {
        expect(carried, `${rel} no longer redirects with '${param}'; drop it from ARRIVED_BY_LINK`).toMatch(
          new RegExp(`[?&]${param}=`),
        );
      }
    }
  });
});
