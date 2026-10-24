import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `config/env.ts` parses once at import, so each case re-imports it under a
 * fresh module registry.
 */
async function bootWithKey(key: string) {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', key);
  return import('../src/config/env.js');
}

describe('ENCRYPTION_KEY format', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('refuses a 64-character key that is not hex, naming the fix', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const passwordStyle = 'Kq7vX2pLmN9rT4wZ8yB3cF6hJ1sD5gA0eU+/Kq7vX2pLmN9rT4wZ8yB3cF6hJ1sD';
    expect(passwordStyle).toHaveLength(64);

    await expect(bootWithKey(passwordStyle)).rejects.toThrow('Invalid environment variables');
    expect(JSON.stringify(logged.mock.calls)).toContain('openssl rand -hex 32');
  });

  it('accepts 64 hex characters and decodes them to a 32-byte key', async () => {
    const hexKey = '5ec0ffee5ec0ffee5ec0ffee5ec0ffee5ec0ffee5ec0ffee5ec0ffee5ec0FFEE';

    const { env } = await bootWithKey(hexKey);
    expect(Buffer.from(env.ENCRYPTION_KEY ?? '', 'hex')).toHaveLength(32);

    const { encryptJson, decryptJson } = await import('../src/lib/secrets.js');
    expect(decryptJson(encryptJson({ ok: true }))).toEqual({ ok: true });
  });
});
