/**
 * The outbound webhook settings parse the way the docs say: WEBHOOK_TIMEOUT_MS
 * defaults to the 10s every release up to 2.2.x used and is bounded to 1-30s,
 * WEBHOOK_APP_MAX_IN_FLIGHT defaults to 8.
 *
 * config/env.ts parses process.env once, at import, so each case re-imports
 * it into a fresh module registry and restores both afterwards.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const KEYS = ['WEBHOOK_TIMEOUT_MS', 'WEBHOOK_APP_MAX_IN_FLIGHT'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function loadEnv(vars: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  vi.resetModules();
  return (await import('../src/config/env.js')).env;
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

describe('outbound webhook env settings', () => {
  it('default to a 10s timeout and 8 in flight per Application', async () => {
    const env = await loadEnv({});
    expect(env.WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(env.WEBHOOK_APP_MAX_IN_FLIGHT).toBe(8);
  });

  it('accept a timeout inside 1-30s', async () => {
    expect((await loadEnv({ WEBHOOK_TIMEOUT_MS: '15000' })).WEBHOOK_TIMEOUT_MS).toBe(15_000);
    expect((await loadEnv({ WEBHOOK_TIMEOUT_MS: '1000' })).WEBHOOK_TIMEOUT_MS).toBe(1_000);
    expect((await loadEnv({ WEBHOOK_TIMEOUT_MS: '30000' })).WEBHOOK_TIMEOUT_MS).toBe(30_000);
  });

  it('refuse to boot on a timeout outside 1-30s', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(loadEnv({ WEBHOOK_TIMEOUT_MS: '999' })).rejects.toThrow();
      await expect(loadEnv({ WEBHOOK_TIMEOUT_MS: '30001' })).rejects.toThrow();
      await expect(loadEnv({ WEBHOOK_APP_MAX_IN_FLIGHT: '0' })).rejects.toThrow();
    } finally {
      quiet.mockRestore();
    }
  });
});
