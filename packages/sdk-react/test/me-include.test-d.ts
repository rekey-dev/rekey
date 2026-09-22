/**
 * Type-level tests for `RekeyBrowserClient.getMe({ include })`: the result
 * gains exactly the properties that were asked for. Checked by
 * `pnpm typecheck` (tsconfig.type-tests.json), never executed.
 */

import { expectTypeOf } from 'vitest';
import type {
  MeInclude,
  EndUserDeviceDto,
  EndUserLicenseDto,
  FeatureCheckDto,
  OrganizationBaseRole,
  PublicPlanCheckoutDto,
  PlanDto,
  OrganizationWithRoleDto,
  ResolvedEntitlementsDto,
  SubscriptionDto,
} from '@rekey.dev/shared-types';
import type { RekeyBrowserClient } from '../src/client.js';

declare const client: RekeyBrowserClient;

export async function plain(): Promise<void> {
  const me = await client.getMe('token');
  if (!me) return;
  expectTypeOf(me.id).toEqualTypeOf<string>();
  expectTypeOf(me.activeOrganizationBaseRole).toEqualTypeOf<OrganizationBaseRole | null>();
  expectTypeOf(me).not.toHaveProperty('entitlements');
}

export async function licenses(): Promise<void> {
  const me = await client.getMe('token', { include: ['licenses'] });
  if (!me) return;
  expectTypeOf(me.licenses).toEqualTypeOf<{ items: EndUserLicenseDto[]; truncated: boolean }>();
  expectTypeOf((await client.listMyLicenses('token')).items).toEqualTypeOf<EndUserLicenseDto[]>();
}

export async function featuresAndPlans(): Promise<void> {
  expectTypeOf(await client.getFeature('token', 'reports')).toEqualTypeOf<FeatureCheckDto>();
  expectTypeOf(await client.hasFeature('token', 'reports')).toEqualTypeOf<boolean>();
  const plans = await client.getPlans();
  expectTypeOf(plans.items[0]!.checkout).toEqualTypeOf<PublicPlanCheckoutDto>();
  const asPlans: PlanDto[] = plans.items;
  void asPlans;
}

export async function some(): Promise<void> {
  const me = await client.getMe('token', { include: ['entitlements', 'device'] });
  expectTypeOf(me).toMatchTypeOf<object | null>();
  if (!me) return;
  expectTypeOf(me.entitlements).toEqualTypeOf<ResolvedEntitlementsDto>();
  expectTypeOf(me.device).toEqualTypeOf<EndUserDeviceDto | null>();
  // @ts-expect-error `organization` was not included
  void me.organization;
}

export async function all(): Promise<void> {
  const me = await client.getMe('token', { include: ['subscription', 'organization'] });
  if (!me) return;
  expectTypeOf(me.subscription).toEqualTypeOf<SubscriptionDto | null>();
  expectTypeOf(me.organization).toEqualTypeOf<OrganizationWithRoleDto | null>();
}

export async function refused(): Promise<void> {
  // @ts-expect-error `Device` is not a supported value
  await client.getMe('token', { include: ['Device'] });
}

/**
 * A list typed `MeInclude[]` could hold any subset at runtime, so nothing it
 * might add is promised: every field is optional and has to be checked.
 */
export async function widened(wanted: MeInclude[]): Promise<void> {
  const me = await client.getMe('token', { include: wanted });
  if (!me) return;
  expectTypeOf(me.entitlements).toEqualTypeOf<ResolvedEntitlementsDto | undefined>();
  expectTypeOf(me.device).toEqualTypeOf<EndUserDeviceDto | null | undefined>();
  // @ts-expect-error possibly undefined: the list might not have included it
  void me.entitlements.features;
}

/** `as const` keeps the list literal, so the fields are promised again. */
export async function asConst(): Promise<void> {
  const wanted = ['subscription'] as const;
  const me = await client.getMe('token', { include: wanted });
  if (!me) return;
  expectTypeOf(me.subscription).toEqualTypeOf<SubscriptionDto | null>();
  expectTypeOf(me).not.toHaveProperty('device');
}
