/**
 * Type-level tests for `RekeyBrowserClient.listMyLicenses`: the page stays
 * positional and `{ organizationId }` is an optional third argument. Checked
 * by `pnpm typecheck` (tsconfig.type-tests.json), never executed.
 */

import { expectTypeOf } from 'vitest';
import type { EndUserLicenseDto, Paged } from '@rekey.dev/shared-types';
import type { RekeyBrowserClient } from '../src/client.js';

declare const client: RekeyBrowserClient;

export async function listMyLicenses(): Promise<void> {
  expectTypeOf(await client.listMyLicenses('token')).toEqualTypeOf<Paged<EndUserLicenseDto>>();
  await client.listMyLicenses('token', { limit: 10, offset: 20 });
  await client.listMyLicenses('token', undefined, { organizationId: 'org_1' });
  await client.listMyLicenses('token', { limit: 10 }, { organizationId: 'org_1' });
  expectTypeOf(client.listMyLicenses).parameter(2).toEqualTypeOf<{ organizationId?: string } | undefined>();

  // @ts-expect-error organizationId is a string id
  await client.listMyLicenses('token', undefined, { organizationId: 1 });
  // @ts-expect-error the options object is the third argument, not the page
  await client.listMyLicenses('token', { organizationId: 'org_1' });
}
