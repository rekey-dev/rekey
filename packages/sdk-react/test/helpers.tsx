/**
 * Shared test helpers for the @rekey.dev/react suite.
 *
 * Auth state is the one piece of global context the control/auth widgets read
 * (via `useUser()`), so we expose a tiny mock for it. The theming context is
 * supplied by each component's own `<Themed>` wrapper, so it needs no mock.
 *
 * Usage:
 *   import { mockUser, type AuthState } from './helpers';
 *   mockUser({ signedIn: true, user: fakeUser });
 *
 * The `vi.mock('../src/hooks.js', …)` factory below is hoisted by Vitest, so
 * it is declared in each test file that needs it; this module only holds the
 * shared state object + fixtures the factory closes over.
 */

import type { EndUserDto } from '@rekey.dev/shared-types';

export interface AuthState {
  user: EndUserDto | null;
  signedIn: boolean;
  loading: boolean;
}

/** A realistic signed-in user (matches `EndUserDtoSchema`). */
export const fakeUser: EndUserDto = {
  id: 'eu_123',
  applicationId: 'app_123',
  email: 'jane@example.com',
  emailVerified: true,
  metadata: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Mutable auth state the hooks mock returns. Reset per test via `setAuth`. */
export const authState: AuthState = {
  user: null,
  signedIn: false,
  loading: false,
};

/** Overwrite the auth state the mocked `useUser()` returns. */
export function setAuth(next: Partial<AuthState>): void {
  authState.user = next.user ?? null;
  authState.signedIn = next.signedIn ?? false;
  authState.loading = next.loading ?? false;
}

/** Signed-in convenience. */
export function signedIn(): void {
  setAuth({ user: fakeUser, signedIn: true, loading: false });
}

/** Signed-out convenience. */
export function signedOut(): void {
  setAuth({ user: null, signedIn: false, loading: false });
}

/** Loading convenience. */
export function loading(): void {
  setAuth({ user: null, signedIn: false, loading: true });
}
