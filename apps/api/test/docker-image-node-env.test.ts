/**
 * The published image runs as production without being told to.
 *
 * `NODE_ENV` unset means `development` (config/env.ts), and development
 * switches off the rules that only make sense on a real deployment: https for
 * outbound webhook targets, the refusal to boot without an encryption key.
 * Someone who runs the bare image with their own environment and forgets
 * `NODE_ENV` must still get the production rules, so each runtime stage sets
 * it itself.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(fileURLToPath(new URL('../../../Dockerfile', import.meta.url)), 'utf8');

describe('Docker image', () => {
  const stages = dockerfile.split(/^FROM /m).slice(1);
  const runtimes = stages.filter((stage) => /^\S+ AS \S+-runtime\b/.test(stage));

  it('has the runtime stages this test expects to find', () => {
    const names = runtimes.map((stage) => /^\S+ AS (\S+)/.exec(stage)![1]);
    expect(names).toContain('api-runtime');
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it.each(runtimes.map((stage) => [/^\S+ AS (\S+)/.exec(stage)![1]!, stage] as const))(
    '%s sets NODE_ENV=production itself',
    (_name, stage) => {
      expect(stage).toMatch(/^ENV NODE_ENV=production$/m);
      // Nothing after it in the stage may set it back.
      const settings = [...stage.matchAll(/^ENV NODE_ENV=(\S+)$/gm)].map((m) => m[1]);
      expect(settings.at(-1)).toBe('production');
    },
  );
});
