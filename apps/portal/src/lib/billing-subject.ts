/**
 * Who a checkout from this session bills, on an Application that bills per
 * organization.
 */

/** The part of the SDK client this reads. */
interface OrganizationLister {
  listOrganizations(
    accessToken: string,
    page: { limit: number },
  ): Promise<{ items: Array<{ id: string; name: string; baseRole: string }> }>;
}

export type BillingOrganization = { id: string; name: string; canManage: boolean };

/**
 * The team this session's billing is about: the active organization when the
 * user belongs to it, else the first team they own or admin, else null.
 * `canManage` reads the API's tier, never the role name: only an OWNER or
 * ADMIN can change a team's plan, a member may look.
 *
 * `limit: 100` deliberately: the default 50-row window could exclude the team.
 *
 * @example
 * const team = await billingOrganization(client, session.accessToken, session.user.activeOrganizationId);
 */
export async function billingOrganization(
  client: OrganizationLister,
  accessToken: string,
  activeOrganizationId?: string | null,
): Promise<BillingOrganization | null> {
  const orgs = await client
    .listOrganizations(accessToken, { limit: 100 })
    .then((r) => r.items)
    .catch(() => []);
  const manages = (o: { baseRole: string }): boolean => o.baseRole === 'OWNER' || o.baseRole === 'ADMIN';
  const chosen = orgs.find((o) => o.id === activeOrganizationId) ?? orgs.find(manages);
  return chosen ? { id: chosen.id, name: chosen.name, canManage: manages(chosen) } : null;
}

/** {@link billingOrganization}, only when the user can change its plan. */
export async function managedBillingOrg(
  client: OrganizationLister,
  accessToken: string,
  activeOrganizationId?: string | null,
): Promise<{ id: string; name: string } | null> {
  const team = await billingOrganization(client, accessToken, activeOrganizationId);
  return team?.canManage ? { id: team.id, name: team.name } : null;
}

/** Where a buyer reviews one plan before checkout. */
export function planReviewPath(slug: string, planSlug: string): string {
  return `/${slug}/plans/${encodeURIComponent(planSlug)}`;
}

/** A path segment as the visitor typed it, decoded once. Null when it is not valid percent-encoding. */
export function decodedSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
