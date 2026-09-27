/**
 * Type-level tests for `licenses.listMine`: the page stays positional and
 * `{ organizationId }` is an optional third argument. Checked by
 * `pnpm typecheck` (tsconfig.type-tests.json), never executed.
 */

import { expectTypeOf } from 'vitest';
import type { EndUserLicenseDto, Paged } from '@rekey.dev/shared-types';
import type { Rekey } from '../src/index.js';

declare const rekey: Rekey;

export async function listMine(): Promise<void> {
  expectTypeOf(await rekey.licenses.listMine('token')).toEqualTypeOf<Paged<EndUserLicenseDto>>();
  await rekey.licenses.listMine('token', { limit: 10, offset: 20 });
  await rekey.licenses.listMine('token', undefined, { organizationId: 'org_1' });
  await rekey.licenses.listMine('token', { limit: 10 }, { organizationId: 'org_1' });
  expectTypeOf(rekey.licenses.listMine).parameter(2).toEqualTypeOf<{ organizationId?: string } | undefined>();

  // @ts-expect-error organizationId is a string id
  await rekey.licenses.listMine('token', undefined, { organizationId: 1 });
  // @ts-expect-error the options object is the third argument, not the page
  await rekey.licenses.listMine('token', { organizationId: 'org_1' });
}
