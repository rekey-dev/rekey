import { describe, expect, it } from 'vitest';
import { firstPublicOrigin, isPublicHttpUrl } from '../src/lib/public-api-origin.js';
import {
  unknownApiKeyText,
  unknownPublishableKeyText,
} from '../src/middleware/api-key-auth.js';

describe('firstPublicOrigin (#578)', () => {
  it('skips an in-cluster service name', () => {
    expect(firstPublicOrigin([undefined, 'http://api:3030'])).toBeNull();
    expect(isPublicHttpUrl('http://api:3030')).toBe(false);
  });

  it('prefers the public webhook base over API_URL, without a trailing slash', () => {
    expect(firstPublicOrigin(['https://api.example.com/', 'http://api:3030'])).toBe(
      'https://api.example.com',
    );
  });

  it('falls back to a public API_URL, and accepts loopback for local development', () => {
    expect(firstPublicOrigin([undefined, 'https://api.example.com'])).toBe('https://api.example.com');
    expect(firstPublicOrigin([undefined, 'http://localhost:3030'])).toBe('http://localhost:3030');
  });

  it('rejects non-http schemes', () => {
    expect(isPublicHttpUrl('ftp://files.example.com')).toBe(false);
  });
});

describe('unknown key text', () => {
  it('names a public origin in both message and fix', () => {
    const text = unknownApiKeyText('https://api.example.com');
    expect(text.message).toBe('API key is unknown, revoked, or expired at https://api.example.com.');
    expect(text.fix).toContain('came from https://api.example.com (Panel');
  });

  it('names no host when the origin is not public', () => {
    for (const text of [unknownApiKeyText(null), unknownPublishableKeyText(null)]) {
      expect(text.message).toContain('on this deployment');
      expect(`${text.message} ${text.fix}`).not.toMatch(/https?:\/\//);
    }
  });

  it('never uses an em dash', () => {
    for (const origin of ['https://api.example.com', null]) {
      for (const text of [unknownApiKeyText(origin), unknownPublishableKeyText(origin)]) {
        expect(`${text.message} ${text.fix}`).not.toContain('—');
      }
    }
  });
});
