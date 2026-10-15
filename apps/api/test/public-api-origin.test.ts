import { describe, expect, it } from 'vitest';
import { firstPublicOrigin, isPublicHttpUrl } from '../src/lib/public-api-origin.js';

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

