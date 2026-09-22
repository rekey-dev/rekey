/**
 * Type-level tests for `auth.getCurrentUser({ include })`: the result gains
 * exactly the properties that were asked for. Checked by `pnpm typecheck`
 * (tsconfig.type-tests.json), never executed.
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
import type { Rekey } from '../src/index.js';

declare const rekey: Rekey;

export async function plain(): Promise<void> {
  const me = await rekey.auth.getCurrentUser('token');
  expectTypeOf(me.id).toEqualTypeOf<string>();
  expectTypeOf(me.activeOrganizationId).toEqualTypeOf<string | null>();
  expectTypeOf(me.activeOrganizationRole).toEqualTypeOf<string | null>();
  expectTypeOf(me.activeOrganizationBaseRole).toEqualTypeOf<OrganizationBaseRole | null>();
  expectTypeOf(me).not.toHaveProperty('entitlements');
  expectTypeOf(me).not.toHaveProperty('device');
  expectTypeOf(me).not.toHaveProperty('licenses');
}

/** PATCH returns what GET returns, role fields included. */
export async function updated(): Promise<void> {
  const me = await rekey.auth.updateCurrentUser('token', { metadata: {} });
  expectTypeOf(me.activeOrganizationBaseRole).toEqualTypeOf<OrganizationBaseRole | null>();
  expectTypeOf(me).not.toHaveProperty('entitlements');
}

export async function licenses(): Promise<void> {
  const me = await rekey.auth.getCurrentUser('token', { include: ['licenses'] });
  expectTypeOf(me.licenses).toEqualTypeOf<{ items: EndUserLicenseDto[]; truncated: boolean }>();
  expectTypeOf(me).not.toHaveProperty('entitlements');
  const page = await rekey.licenses.listMine('token');
  expectTypeOf(page.items).toEqualTypeOf<EndUserLicenseDto[]>();
  // @ts-expect-error a holder's licence carries no key hash
  void page.items[0]!.keyHash;
}

export async function featuresAndPlans(): Promise<void> {
  expectTypeOf(await rekey.billing.getFeature('token', 'reports')).toEqualTypeOf<FeatureCheckDto>();
  expectTypeOf(await rekey.billing.hasFeature('token', 'reports')).toEqualTypeOf<boolean>();
  expectTypeOf(await rekey.billing.hasFeatureFor('eu_1', 'reports')).toEqualTypeOf<boolean>();
  const plans = await rekey.billing.getPlans();
  expectTypeOf(plans.items[0]!.checkout).toEqualTypeOf<PublicPlanCheckoutDto>();
  // Code typed against PlanDto before `checkout` appeared keeps compiling.
  const asPlans: PlanDto[] = plans.items;
  void asPlans;
  // @ts-expect-error the public catalogue carries no blocker detail
  void plans.items[0]!.checkout.blockers;
}

export async function some(): Promise<void> {
  const me = await rekey.auth.getCurrentUser('token', { include: ['entitlements', 'device'] });
  expectTypeOf(me.entitlements).toEqualTypeOf<ResolvedEntitlementsDto>();
  expectTypeOf(me.device).toEqualTypeOf<EndUserDeviceDto | null>();
  expectTypeOf(me).not.toHaveProperty('subscription');
  expectTypeOf(me).not.toHaveProperty('organization');
  // @ts-expect-error `subscription` was not included
  void me.subscription;
}

export async function all(): Promise<void> {
  const me = await rekey.auth.getCurrentUser('token', {
    include: ['organization', 'subscription', 'device', 'entitlements'],
  });
  expectTypeOf(me.subscription).toEqualTypeOf<SubscriptionDto | null>();
  expectTypeOf(me.organization).toEqualTypeOf<OrganizationWithRoleDto | null>();
  expectTypeOf(me.entitlements.features).toEqualTypeOf<Record<string, boolean | number | string>>();
}

export async function refused(): Promise<void> {
  // @ts-expect-error `devices` is not a supported value
  await rekey.auth.getCurrentUser('token', { include: ['devices'] });
}

/**
 * A list typed `MeInclude[]` could hold any subset at runtime, so nothing it
 * might add is promised: every field is optional and has to be checked.
 */
export async function widened(wanted: MeInclude[]): Promise<void> {
  const me = await rekey.auth.getCurrentUser('token', { include: wanted });
  expectTypeOf(me.entitlements).toEqualTypeOf<ResolvedEntitlementsDto | undefined>();
  expectTypeOf(me.device).toEqualTypeOf<EndUserDeviceDto | null | undefined>();
  // @ts-expect-error possibly undefined: the list might not have included it
  void me.entitlements.features;
}

/** `as const` keeps the list literal, so the fields are promised again. */
export async function asConst(): Promise<void> {
  const wanted = ['subscription'] as const;
  const me = await rekey.auth.getCurrentUser('token', { include: wanted });
  expectTypeOf(me.subscription).toEqualTypeOf<SubscriptionDto | null>();
  expectTypeOf(me).not.toHaveProperty('device');
}
