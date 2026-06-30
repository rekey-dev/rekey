/**
 * Control components — the gating primitives that the whole security model
 * rests on. These decide whether a region of UI renders at all, so a regression
 * here silently leaks (or hides) protected UI.
 *
 * Covers:
 *   - <SignedIn> / <SignedOut> switching on auth state (and staying neutral
 *     while loading — never flash protected UI during resolution).
 *   - <RelipayLoading> / <RelipayLoaded> mutual exclusivity.
 *   - <Protect> gating by feature flag, role, and predicate — allow vs deny vs
 *     fallback — including the fail-closed posture when authorization is absent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { authState, setAuth, signedIn, signedOut, loading } from './helpers';

// Mock the hooks module so `useUser()` returns our controllable state. The
// control components import `useUser` from './hooks.js'.
vi.mock('../src/hooks.js', () => ({
  useUser: () => ({ user: authState.user, signedIn: authState.signedIn, loading: authState.loading }),
}));

import { SignedIn, SignedOut } from '../src/components.js';
import { Protect, RelipayLoading, RelipayLoaded } from '../src/control.js';

beforeEach(() => setAuth({}));

describe('<SignedIn> / <SignedOut>', () => {
  it('renders SignedIn children only when signed in', () => {
    signedIn();
    render(
      <>
        <SignedIn><span>secret</span></SignedIn>
        <SignedOut><span>public</span></SignedOut>
      </>,
    );
    expect(screen.queryByText('secret')).not.toBeNull();
    expect(screen.queryByText('public')).toBeNull();
  });

  it('renders SignedOut children only when signed out', () => {
    signedOut();
    render(
      <>
        <SignedIn><span>secret</span></SignedIn>
        <SignedOut><span>public</span></SignedOut>
      </>,
    );
    expect(screen.queryByText('secret')).toBeNull();
    expect(screen.queryByText('public')).not.toBeNull();
  });

  it('renders NEITHER while the session is still loading (no protected-UI flash)', () => {
    loading();
    render(
      <>
        <SignedIn><span>secret</span></SignedIn>
        <SignedOut><span>public</span></SignedOut>
      </>,
    );
    expect(screen.queryByText('secret')).toBeNull();
    expect(screen.queryByText('public')).toBeNull();
  });
});

describe('<RelipayLoading> / <RelipayLoaded>', () => {
  it('shows Loading children while resolving and Loaded children after', () => {
    loading();
    const { rerender } = render(
      <>
        <RelipayLoading><span>spinner</span></RelipayLoading>
        <RelipayLoaded><span>app</span></RelipayLoaded>
      </>,
    );
    expect(screen.queryByText('spinner')).not.toBeNull();
    expect(screen.queryByText('app')).toBeNull();

    signedIn(); // loading -> false
    rerender(
      <>
        <RelipayLoading><span>spinner</span></RelipayLoading>
        <RelipayLoaded><span>app</span></RelipayLoaded>
      </>,
    );
    expect(screen.queryByText('spinner')).toBeNull();
    expect(screen.queryByText('app')).not.toBeNull();
  });
});

describe('<Protect> — feature gate', () => {
  it('renders children when the feature flag is truthy', () => {
    signedIn();
    render(
      <Protect authorization={{ features: { analytics: true } }} feature="analytics" fallback={<span>locked</span>}>
        <span>unlocked</span>
      </Protect>,
    );
    expect(screen.queryByText('unlocked')).not.toBeNull();
    expect(screen.queryByText('locked')).toBeNull();
  });

  it('renders fallback when the feature flag is falsy', () => {
    signedIn();
    render(
      <Protect authorization={{ features: { analytics: false } }} feature="analytics" fallback={<span>locked</span>}>
        <span>unlocked</span>
      </Protect>,
    );
    expect(screen.queryByText('unlocked')).toBeNull();
    expect(screen.queryByText('locked')).not.toBeNull();
  });

  it('renders fallback when the feature is missing entirely', () => {
    signedIn();
    render(
      <Protect authorization={{ features: {} }} feature="analytics" fallback={<span>locked</span>}>
        <span>unlocked</span>
      </Protect>,
    );
    expect(screen.queryByText('unlocked')).toBeNull();
    expect(screen.queryByText('locked')).not.toBeNull();
  });
});

describe('<Protect> — role gate', () => {
  it('allows when the role is in the allow-list (array form)', () => {
    signedIn();
    render(
      <Protect authorization={{ role: 'ADMIN' }} role={['OWNER', 'ADMIN']} fallback={<span>nope</span>}>
        <span>admin-tools</span>
      </Protect>,
    );
    expect(screen.queryByText('admin-tools')).not.toBeNull();
  });

  it('allows when the role matches the single-string form', () => {
    signedIn();
    render(
      <Protect authorization={{ role: 'OWNER' }} role="OWNER" fallback={<span>nope</span>}>
        <span>owner-tools</span>
      </Protect>,
    );
    expect(screen.queryByText('owner-tools')).not.toBeNull();
  });

  it('denies when the role is not in the allow-list', () => {
    signedIn();
    render(
      <Protect authorization={{ role: 'MEMBER' }} role={['OWNER', 'ADMIN']} fallback={<span>nope</span>}>
        <span>admin-tools</span>
      </Protect>,
    );
    expect(screen.queryByText('admin-tools')).toBeNull();
    expect(screen.queryByText('nope')).not.toBeNull();
  });
});

describe('<Protect> — predicate gate (numeric limits)', () => {
  it('allows when the predicate over features passes', () => {
    signedIn();
    render(
      <Protect
        authorization={{ features: { max_qr_codes: 10 } }}
        condition={(a) => Number(a.features?.max_qr_codes) >= 10}
        fallback={<span>nope</span>}
      >
        <span>bulk</span>
      </Protect>,
    );
    expect(screen.queryByText('bulk')).not.toBeNull();
  });

  it('denies when the predicate fails', () => {
    signedIn();
    render(
      <Protect
        authorization={{ features: { max_qr_codes: 3 } }}
        condition={(a) => Number(a.features?.max_qr_codes) >= 10}
        fallback={<span>nope</span>}
      >
        <span>bulk</span>
      </Protect>,
    );
    expect(screen.queryByText('bulk')).toBeNull();
    expect(screen.queryByText('nope')).not.toBeNull();
  });
});

describe('<Protect> — security posture', () => {
  it('fails closed (denies) when signed in but authorization is omitted', () => {
    signedIn();
    render(
      <Protect feature="analytics" fallback={<span>locked</span>}>
        <span>unlocked</span>
      </Protect>,
    );
    expect(screen.queryByText('unlocked')).toBeNull();
    expect(screen.queryByText('locked')).not.toBeNull();
  });

  it('denies a signed-OUT user even when authorization would pass', () => {
    signedOut();
    render(
      <Protect authorization={{ features: { analytics: true } }} feature="analytics" fallback={<span>locked</span>}>
        <span>unlocked</span>
      </Protect>,
    );
    expect(screen.queryByText('unlocked')).toBeNull();
    expect(screen.queryByText('locked')).not.toBeNull();
  });

  it('renders nothing at all while loading (neither children nor fallback)', () => {
    loading();
    const { container } = render(
      <Protect authorization={{ features: { analytics: true } }} feature="analytics" fallback={<span>locked</span>}>
        <span>unlocked</span>
      </Protect>,
    );
    expect(screen.queryByText('unlocked')).toBeNull();
    expect(screen.queryByText('locked')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('combines feature AND role — both must pass', () => {
    signedIn();
    const tree = (
      <Protect
        authorization={{ features: { analytics: true }, role: 'MEMBER' }}
        feature="analytics"
        role={['OWNER', 'ADMIN']}
        fallback={<span>locked</span>}
      >
        <span>unlocked</span>
      </Protect>
    );
    render(tree);
    // feature passes but role fails -> denied
    expect(screen.queryByText('unlocked')).toBeNull();
    expect(screen.queryByText('locked')).not.toBeNull();
  });
});
