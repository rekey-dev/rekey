/**
 * Whose name is on an Application's mail when it rides the shared pool.
 *
 * The address belongs to the deployment, so the display name has to say who the
 * mail is about AND that it left someone else's domain. Sending as a bare
 * "Rekey" told the recipient nothing about which product had emailed them —
 * every Application's verification and password-reset mail arrived under one
 * name — and sending as a bare "Acme" would claim a sending identity Acme does
 * not have. `Acme (via Rekey)` is what Google Groups and GitHub do here.
 *
 * The rule only applies to the shared pool. An Application with its own
 * credentials sends from its own domain, so there is nothing to disclose and
 * nothing is appended — that path never calls this function.
 *
 * The deployment name is passed in rather than read from the environment. The
 * first version of this test read `env.RESEND_DEFAULT_FROM_NAME` and skipped
 * when it was unset — which it is under test, so three of five cases silently
 * asserted nothing while the file reported green.
 */

import { describe, expect, it } from 'vitest';
import type { Application } from '@prisma/client';
import { pooledFromName } from '../src/lib/email-transport.js';

const DEPLOYMENT = 'Rekey';

/** Only the two fields the rule reads. */
function app(name: string, emailConfig: Record<string, unknown> = {}): Application {
  return { name, emailConfig } as unknown as Application;
}

describe('pooledFromName', () => {
  it('discloses the deployment the mail actually left', () => {
    expect(pooledFromName(app('Acme'), DEPLOYMENT)).toBe('Acme (via Rekey)');
  });

  it("uses the operator's own fromName verbatim when they set one", () => {
    // An operator who configured a name has already decided how they want to
    // appear; appending to it would override a deliberate choice.
    expect(pooledFromName(app('Acme', { fromName: 'Acme Support' }), DEPLOYMENT)).toBe(
      'Acme Support',
    );
  });

  it('does not disclose the deployment to itself', () => {
    // Rekey Cloud's own `account` Application would otherwise send as
    // "Rekey (via Rekey)".
    expect(pooledFromName(app('Rekey'), DEPLOYMENT)).toBe('Rekey');
    expect(pooledFromName(app('REKEY'), DEPLOYMENT)).toBe('REKEY');
    expect(pooledFromName(app('  Rekey  '), DEPLOYMENT)).toBe('Rekey');
  });

  it('falls back to the deployment name when the Application has none', () => {
    expect(pooledFromName(app(''), DEPLOYMENT)).toBe(DEPLOYMENT);
    expect(pooledFromName(app('   '), DEPLOYMENT)).toBe(DEPLOYMENT);
  });

  it('emits the bare Application name when the deployment has no name to disclose', () => {
    // A self-hoster who never set a default from-name has nothing to append,
    // and "Acme (via )" would be worse than "Acme".
    expect(pooledFromName(app('Acme'), undefined)).toBe('Acme');
    expect(pooledFromName(app('Acme'), '   ')).toBe('Acme');
  });

  it('never claims a bare Application identity while a deployment name exists', () => {
    // The regression that matters: a recipient must not see "Acme" alone on
    // mail sent from the deployment's address, because that is an identity
    // claim Acme cannot back.
    for (const name of ['Acme', 'Globex', 'a']) {
      const out = pooledFromName(app(name), DEPLOYMENT);
      expect(out).not.toBe(name);
      expect(out).toBe(`${name} (via ${DEPLOYMENT})`);
    }
  });
});
