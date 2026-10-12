/**
 * Who a checkout from this session bills, on an Application that bills per
 * organization.
 */

/** The part of the SDK client this reads. */
interface OrganizationLister {
  listOrganizations(
    accessToken: string,
    page: { limit: number },
  ): Promise<{ items: Array<{ id: string; name: string; role: string }> }>;
}

/**
 * The first team the signed-in user owns or admins, or null. Only an owner or
 * admin can change a team's plan; a member may look.
 *
 * `limit: 100` deliberately: this picks the first team the user can manage,
 * and the default 50-row window could exclude it for someone in many teams.
 *
 * @example
 * const team = await managedBillingOrg(client, session.accessToken);
 */
export async function managedBillingOrg(
  client: OrganizationLister,
  accessToken: string,
): Promise<{ id: string; name: string } | null> {
  const orgs = await client
    .listOrganizations(accessToken, { limit: 100 })
    .then((r) => r.items)
    .catch(() => []);
  const managed = orgs.find((o) => o.role === 'OWNER' || o.role === 'ADMIN');
  return managed ? { id: managed.id, name: managed.name } : null;
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
