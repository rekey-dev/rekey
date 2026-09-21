/**
 * Guard: a credential never travels in a `redirect()` query, and the team
 * page's invitation link reaches the operator.
 *
 * Both halves of rekey issue #569. The invitation token used to be handed to
 * the next render as `/team?inviteToken=…`, which was wrong twice over.
 *
 * It leaked: that token joins a workspace, and in the URL it lands in browser
 * history, in the `Referer` of the next outbound link, and in every access log
 * in between. The panel's other one-time secrets (the API key, the webhook
 * signing secret, the licence keys) already go through a short-lived httpOnly
 * `rekey_reveal_*` cookie instead, and now so does this one.
 *
 * And it never arrived: on a production build the client does not commit an
 * action's `redirect()`, so the query the token was riding in was never read
 * by anything. The link is shown exactly once, so the operator got it zero
 * times and had to revoke and retry, which did the same thing again. The form
 * opts into `reloadOnSettle` for that, which is the only mechanism measured to
 * put a rendered result back on screen.
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
const teamPage = path.join(srcDir, 'app', '(authed)', 'team', 'page.tsx');

/**
 * Query parameter names that carry a credential. A redirect target is a URL:
 * whatever is in it is logged, refered and kept in history, so none of these
 * belongs in one. Add a name here when a new secret appears; the fix is always
 * the `rekey_reveal_*` cookie, never a longer name.
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
];

/**
 * Pages the operator reaches BY a link that already contains the token: the
 * accept-invite landing page and the password reset form. The token is in
 * their URL by construction, put there by the email, and these redirects only
 * preserve it across a validation failure so the form still works on the
 * second try. There is nothing to move to a cookie, because the cookie would
 * have to be written by a request that has not happened yet. Anything else
 * that wants to be here is the bug this file is about.
 */
const ARRIVED_BY_LINK = [
  path.join('app', 'accept-invite', 'page.tsx'),
  path.join('app', 'reset-password', 'page.tsx'),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * The argument text of every `redirect(…)` call in a source file, with its
 * line number. Balanced on parentheses so a target built from
 * `` `…${encodeURIComponent(x)}…` `` is not cut short, and comments are
 * blanked first so a docblock describing the old shape is not scanned.
 */
export function redirectTargets(source: string): { arg: string; line: number }[] {
  const text = blankBlockComments(source).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const found: { arg: string; line: number }[] = [];
  const call = /\bredirect\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < text.length && depth > 0; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') depth -= 1;
    }
    found.push({
      arg: text.slice(start, i - 1),
      line: text.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

describe('credentials never ride in a redirect query', () => {
  it('no redirect target in the panel assigns a credential parameter', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      const rel = path.relative(srcDir, file);
      if (ARRIVED_BY_LINK.includes(rel)) continue;
      const source = readFileSync(file, 'utf8');
      if (!source.includes('redirect(')) continue;
      for (const { arg, line } of redirectTargets(source)) {
        for (const param of CREDENTIAL_PARAMS) {
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
});

describe('the team page hands the invitation link over a cookie', () => {
  const source = readFileSync(teamPage, 'utf8');

  it('writes the token to a short-lived httpOnly rekey_reveal cookie', () => {
    expect(source).toMatch(/rekey_reveal_invite/);
    const set = source.slice(source.indexOf('INVITE_REVEAL_COOKIE,'));
    expect(set).toMatch(/httpOnly: true/);
    expect(set).toMatch(/secure: await cookieSecure\(\)/);
    expect(set).toMatch(/path: '\/team'/);
  });

  it('reads the token from that cookie, not from searchParams', () => {
    expect(source).not.toMatch(/sp\.inviteToken/);
    expect(source).toMatch(/get\(INVITE_REVEAL_COOKIE\)/);
  });

  it('gives the invite form a mechanism that puts the link back on screen', () => {
    // Without this the action's `redirect()` is the only thing that could show
    // the banner, and on a production build it never commits.
    expect(blankBlockComments(source)).toMatch(/<ActionForm[^>]*\breloadOnSettle\b/s);
  });
});
