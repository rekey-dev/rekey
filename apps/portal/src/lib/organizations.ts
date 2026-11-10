/**
 * The customer's organizations, read with their own token, and what their
 * tier in one lets them do. Rekey gates on `baseRole`, never on a role name
 * (docs/organization-roles.md), so every decision here reads the tier the API
 * returned.
 */

import 'server-only';
import type {
  OrganizationInvitationPreviewDto,
  OrganizationMemberDto,
  OrganizationPendingInvitationDto,
  OrganizationWithRoleDto,
} from '@rekey.dev/shared-types';
import type { PortalConfig } from './config';
import { customerCall } from './customer-call';
import { publishableKeyPost } from './social-sign-in';

export type BaseRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type OrganizationMember = OrganizationMemberDto;
export type OrganizationRole = { name: string; baseRole: BaseRole; isDefault: boolean; disabled: boolean };

const PAGE = 'limit=100';

/**
 * The session's active organization. `GET /api/v1/auth/me`, which the session
 * user comes from, returns it, though the SDK's user type does not declare it.
 */
export function activeOrganizationOf(user: object): string | null {
  const id = (user as { activeOrganizationId?: unknown }).activeOrganizationId;
  return typeof id === 'string' && id ? id : null;
}

export function organizationPath(slug: string): string {
  return `/${slug}/organization`;
}

export async function listOrganizations(config: PortalConfig, accessToken: string): Promise<OrganizationWithRoleDto[] | null> {
  const result = await customerCall<{ items: OrganizationWithRoleDto[] }>(
    config,
    accessToken,
    'GET',
    `/api/v1/users/me/organizations?${PAGE}`,
  );
  return result.ok ? result.data.items : null;
}

export async function listMembers(
  config: PortalConfig,
  accessToken: string,
  organizationId: string,
): Promise<OrganizationMember[] | null> {
  const result = await customerCall<{ items: OrganizationMember[] }>(
    config,
    accessToken,
    'GET',
    `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/members?${PAGE}`,
  );
  return result.ok ? result.data.items : null;
}

/** Null when they cannot be read, including for a member who may not see them. */
export async function listPendingInvitations(
  config: PortalConfig,
  accessToken: string,
  organizationId: string,
): Promise<OrganizationPendingInvitationDto[] | null> {
  const result = await customerCall<{ items: OrganizationPendingInvitationDto[] }>(
    config,
    accessToken,
    'GET',
    `/api/v1/users/me/organizations/${encodeURIComponent(organizationId)}/invitations?${PAGE}`,
  );
  return result.ok ? result.data.items : null;
}

export async function listRoles(config: PortalConfig, accessToken: string): Promise<OrganizationRole[]> {
  const result = await customerCall<OrganizationRole[]>(config, accessToken, 'GET', '/api/v1/users/me/organizations/roles');
  return result.ok ? result.data : [];
}

/** OWNER and ADMIN manage members, invitations and billing. */
export function managesMembers(tier: BaseRole): boolean {
  return tier === 'OWNER' || tier === 'ADMIN';
}

/**
 * Whether `actor` may change or remove a member on tier `target`: an OWNER
 * manages anyone, an ADMIN manages ADMIN and MEMBER, nobody manages themselves here.
 */
export function managesTier(actor: BaseRole, target: BaseRole): boolean {
  if (actor === 'OWNER') return true;
  return actor === 'ADMIN' && target !== 'OWNER';
}

/** The roles `actor` may hand out: live ones, and no OWNER-tier role for an ADMIN. */
export function assignableRoles(actor: BaseRole, roles: readonly OrganizationRole[]): OrganizationRole[] {
  if (!managesMembers(actor)) return [];
  return roles.filter((r) => !r.disabled && (actor === 'OWNER' || r.baseRole !== 'OWNER'));
}

/**
 * What an invitation token offers, read without a session. `unavailable` when
 * the API says it can no longer be accepted; null when it could not be read.
 */
export async function previewInvitation(
  slug: string,
  token: string,
): Promise<OrganizationInvitationPreviewDto | 'unavailable' | null> {
  const result = await publishableKeyPost<OrganizationInvitationPreviewDto>(
    slug,
    '/api/v1/auth/organizations/invitation-preview',
    { token },
  );
  if (result.ok) return result.data;
  return result.code === 'ORGANIZATION_INVITATION_UNAVAILABLE' ? 'unavailable' : null;
}
