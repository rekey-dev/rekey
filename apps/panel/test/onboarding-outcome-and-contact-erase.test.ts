/**
 * Operator actions on one person: marking an end-user's onboarding complete or
 * skipped, and erasing a contact from a list page. Also the role options the
 * member role picker confirms against.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceRoleOptions } from '@/lib/workspace-roles';

interface Call {
  method: string;
  path: string;
}

const calls: Call[] = [];
let refusal: string | null = null;

class FakePanelApiError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

vi.mock('@/lib/api', () => ({
  PanelApiError: FakePanelApiError,
  errorQuery: async (err: FakePanelApiError) => `error=${err.code}`,
  api: async (call: Call) => {
    calls.push(call);
    if (refusal !== null) throw new FakePanelApiError(refusal);
    return {};
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({ cookies: async () => ({}), headers: async () => new Headers() }));

const { setOnboardingOutcome } = await import('@/app/(authed)/applications/[id]/end-users/[euid]/actions');
const { eraseContact } = await import('@/app/(authed)/applications/[id]/lists/[listId]/actions');

beforeEach(() => {
  calls.length = 0;
  refusal = null;
});

describe('setOnboardingOutcome', () => {
  it('posts complete and lands on the completed flag', async () => {
    await expect(setOnboardingOutcome('app_1', 'eu_1', 'complete')).rejects.toThrow(
      'REDIRECT /applications/app_1/end-users/eu_1?onboarding=completed',
    );
    expect(calls).toEqual([
      { method: 'POST', path: '/api/v1/tenant/applications/app_1/end-users/eu_1/onboarding/complete' },
    ]);
  });

  it('posts skip and lands on the skipped flag', async () => {
    await expect(setOnboardingOutcome('app_1', 'eu_1', 'skip')).rejects.toThrow('?onboarding=skipped');
    expect(calls[0]!.path).toBe('/api/v1/tenant/applications/app_1/end-users/eu_1/onboarding/skip');
  });

  it('turns a refusal into an error code the page explains', async () => {
    refusal = 'PROFILE_INCOMPLETE';
    await expect(setOnboardingOutcome('app_1', 'eu_1', 'complete')).rejects.toThrow(
      'REDIRECT /applications/app_1/end-users/eu_1?onboardingError=PROFILE_INCOMPLETE',
    );
  });
});

describe('eraseContact', () => {
  it('deletes the contact from the Application and lands back on the list', async () => {
    await expect(eraseContact('app_1', 'list_1', 'ct_1')).rejects.toThrow(
      'REDIRECT /applications/app_1/lists/list_1?contactErased=1',
    );
    expect(calls).toEqual([{ method: 'DELETE', path: '/api/v1/tenant/applications/app_1/contacts/ct_1' }]);
  });

  it('shows the refusal on the list when the operator is not an owner', async () => {
    refusal = 'TENANT_ROLE_INSUFFICIENT';
    await expect(eraseContact('app_1', 'list_1', 'ct_1')).rejects.toThrow('?error=TENANT_ROLE_INSUFFICIENT');
  });
});

describe('workspaceRoleOptions', () => {
  it('gives each role its own consequence, with the owner warning only on OWNER', () => {
    const options = workspaceRoleOptions(['MEMBER', 'ADMIN', 'OWNER']);
    expect(options.map((o) => [o.value, o.label])).toEqual([
      ['MEMBER', 'Member'],
      ['ADMIN', 'Admin'],
      ['OWNER', 'Owner'],
    ]);
    expect(options.filter((o) => o.consequence.includes('fully trust')).map((o) => o.value)).toEqual(['OWNER']);
  });
});
