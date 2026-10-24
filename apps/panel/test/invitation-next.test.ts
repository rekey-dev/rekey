import { describe, expect, it } from 'vitest';
import { invitationTokenIn } from '@/lib/invitation-next';

describe('invitationTokenIn', () => {
  it('reads the token from an accept-invite destination', () => {
    expect(invitationTokenIn('/accept-invite?token=abc_123')).toBe('abc_123');
    expect(invitationTokenIn('/accept-invite?token=rp_opinv_x&e=login')).toBe('rp_opinv_x');
  });

  it('ignores every other destination and an empty token', () => {
    expect(invitationTokenIn(null)).toBeNull();
    expect(invitationTokenIn('/applications?token=abc')).toBeNull();
    expect(invitationTokenIn('/accept-invite')).toBeNull();
    expect(invitationTokenIn('/accept-invite?token=')).toBeNull();
  });
});
