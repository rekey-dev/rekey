/**
 * Fixtures for suites whose subject is not email confirmation.
 *
 * A password sign-up proves nothing about the address, so the account it
 * creates is unverified and may not add a passkey, a second factor, a linked
 * provider or (for operators) an access token. A suite about MFA replay or
 * PAT scopes wants an account that has already confirmed its address, the way
 * a real one would have by the time it reaches those screens. Calling one of
 * these at the top of a file makes every sign-up in that file land confirmed.
 *
 * Only the fixture is shortened. The refusals themselves run unmodified and
 * are covered in unverified-account-claim.test.ts and
 * unverified-operator-claim.test.ts.
 */

import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { invalidateOperatorAuth } from '../src/lib/operator-auth-cache.js';
import { authService } from '../src/modules/auth/auth.service.js';
import { tenantAuthService } from '../src/modules/tenant-auth/tenant-auth.service.js';

/**
 * Every operator sign-up in this file, or in the `describe` this is called
 * in, confirms its address as it is created.
 *
 * Assigned over the method, not spied on. Many suites call
 * `vi.restoreAllMocks()` in the same `beforeEach` that signs their operator
 * up, which would take a spy away just before it was needed; an assignment is
 * left alone by that call. It is put in place by a `beforeAll` and taken away
 * by the matching `afterAll`, so it covers exactly the block it was called in
 * and a `describe` beside it still gets unconfirmed operators. Call it before
 * the block's own `beforeAll`, so it is in place when that one signs up.
 */
export function operatorsConfirmTheirEmail(): void {
  let previous: typeof tenantAuthService.signUpAndCreateWorkspace | undefined;
  beforeAll(() => {
    previous = tenantAuthService.signUpAndCreateWorkspace;
    const signUp = previous.bind(tenantAuthService);
    tenantAuthService.signUpAndCreateWorkspace = async (input) => {
      const result = await signUp(input);
      await prisma.tenantUser.update({ where: { id: result.user.id }, data: { emailVerified: true } });
      invalidateOperatorAuth(result.user.id);
      return { ...result, user: { ...result.user, emailVerified: true } };
    };
  });
  afterAll(() => {
    if (previous) tenantAuthService.signUpAndCreateWorkspace = previous;
  });
}

/** Every end-user password sign-up in this file confirms its address as it is created. */
export function endUsersConfirmTheirEmail(): void {
  const install = (): void => {
    if (vi.isMockFunction(authService.signUp)) return;
    const signUp = authService.signUp.bind(authService);
    vi.spyOn(authService, 'signUp').mockImplementation(async (input) => {
      const result = await signUp(input);
      await prisma.endUser.update({ where: { id: result.endUser.id }, data: { emailVerified: true } });
      return { ...result, endUser: { ...result.endUser, emailVerified: true } };
    });
  };
  keepInstalled(install, () => authService.signUp);
}

/**
 * Installed now, so a `beforeAll` fixture is covered, again before each test
 * in case the file restores every mock between tests, and removed when the
 * file ends so the next file in the same worker starts clean.
 */
function keepInstalled(install: () => void, current: () => unknown): void {
  install();
  beforeEach(install);
  afterAll(() => {
    const fn = current();
    if (vi.isMockFunction(fn)) fn.mockRestore();
  });
}
