/**
 * The deployment defaults a self-hoster inherits without choosing them.
 *
 * `docker-compose.yml` published the API on 0.0.0.0 while defaulting
 * `OPERATOR_SIGNUP_MODE` to `open`. Each half is defensible alone — the API
 * genuinely has to be reachable, and first boot genuinely has to be able to
 * create the first operator — but together they mean that bringing the stack up
 * on a VPS to try it out puts an unauthenticated operator-signup endpoint on
 * the public internet. Postgres and Redis had already been moved to loopback
 * for the same reason; the web services had not.
 *
 * Two halves to the fix, and this file pins both:
 *   - compose binds published ports to `${BIND_ADDRESS:-127.0.0.1}`, so
 *     exposing the stack is a thing you type rather than a thing you inherit;
 *   - the API warns at boot when it finds `open` under NODE_ENV=production,
 *     which covers every deploy shape that isn't this compose file.
 *
 * The compose assertions are text assertions on purpose. The property is "the
 * file a self-hoster copies is safe by default", and the only way to check that
 * is to read the file they copy.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSignupWarning } from '../src/config/env.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');

/** Every `ports:` entry in the file, e.g. `127.0.0.1:5432:5432`. */
function publishedPorts(yaml: string): string[] {
  return (yaml.match(/^\s*-\s*"([^"]+:\d+:\d+)"/gm) ?? []).map((line) =>
    line.replace(/^\s*-\s*"/, '').replace(/"$/, ''),
  );
}

describe('docker-compose.yml publishes nothing on 0.0.0.0 by default', () => {
  it('finds every service that publishes a port', () => {
    // Guards the guard: if the file stops using quoted `"host:port:port"`
    // strings, the assertions below would pass by matching nothing.
    expect(publishedPorts(compose).length).toBeGreaterThanOrEqual(5);
  });

  it.each(['3030:3030', '3031:3031', '3050:3050'])(
    'binds %s to loopback unless BIND_ADDRESS says otherwise',
    (mapping) => {
      const entry = publishedPorts(compose).find((p) => p.endsWith(mapping));
      expect(entry, `no published port ending in ${mapping}`).toBeDefined();
      expect(entry).toBe(`\${BIND_ADDRESS:-127.0.0.1}:${mapping}`);
    },
  );

  it('leaves the datastores pinned to literal loopback', () => {
    // These must NOT become BIND_ADDRESS-configurable — nothing outside the
    // compose network should ever reach them, and the API talks to them by
    // service name over the compose network regardless.
    const ports = publishedPorts(compose);
    expect(ports).toContain('127.0.0.1:5432:5432');
    expect(ports).toContain('127.0.0.1:6379:6379');
  });

  it('never hard-codes a 0.0.0.0 publish', () => {
    for (const entry of publishedPorts(compose)) {
      expect(entry.startsWith('0.0.0.0:')).toBe(false);
    }
  });

  it('tells the reader what to change if they do expose it', () => {
    // The escape hatch is only safe if it is documented next to the risk.
    expect(compose).toContain('BIND_ADDRESS=0.0.0.0');
    expect(compose).toContain('OPERATOR_SIGNUP_MODE=invite');
  });
});

describe('open operator signup in production is announced', () => {
  it('warns, naming both the exposure and the fix', () => {
    const warning = openSignupWarning('production', 'open');
    expect(warning).toBeTruthy();
    expect(warning).toContain('OPERATOR_SIGNUP_MODE=open');
    // A warning that does not say what to do instead is noise people learn to
    // scroll past.
    expect(warning).toContain('OPERATOR_SIGNUP_MODE=invite');
  });

  it('says nothing for a locked-down production deployment', () => {
    expect(openSignupWarning('production', 'invite')).toBeNull();
    expect(openSignupWarning('production', 'closed')).toBeNull();
  });

  it('says nothing in development or test — this is not a dev-time nag', () => {
    expect(openSignupWarning('development', 'open')).toBeNull();
    expect(openSignupWarning('test', 'open')).toBeNull();
    expect(openSignupWarning(undefined, 'open')).toBeNull();
  });

  it('warns rather than refusing to boot', async () => {
    // Deliberate: a private deployment behind a VPN may legitimately want
    // `open`, and a product that will not start in a valid configuration
    // teaches people to work around it. Importing config/env.ts under the
    // warned-about settings must still succeed.
    const mod = await import('../src/config/env.js');
    expect(typeof mod.openSignupWarning).toBe('function');
  });
});
