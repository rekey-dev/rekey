/**
 * Workspace roles in the words the panel shows people. The API's role codes
 * stay as they are; nothing here is sent back to it except the code.
 */

export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'MEMBER';

export const WORKSPACE_ROLES: readonly WorkspaceRole[] = ['MEMBER', 'ADMIN', 'OWNER'];

export const ROLE_LABEL: Record<WorkspaceRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  MEMBER: 'Member',
};

export type AppGrantRole = 'APP_VIEWER' | 'APP_BILLING' | 'APP_ADMIN';

export const APP_GRANT_ROLES: readonly AppGrantRole[] = ['APP_VIEWER', 'APP_BILLING', 'APP_ADMIN'];

/** What a member may do inside one app they are given. */
export const APP_GRANT_LABEL: Record<AppGrantRole, string> = {
  APP_ADMIN: 'Full access',
  APP_BILLING: 'Billing and payments',
  APP_VIEWER: 'View only',
};

/** One line on what the role is for, for pickers and badges. */
export const ROLE_SUMMARY: Record<WorkspaceRole, string> = {
  OWNER: 'Full control, including other owners and deleting the workspace.',
  ADMIN: 'Runs every app and invites members, but cannot change admins or owners.',
  MEMBER: 'Works only in the apps you give them access to.',
};

const ROLE_CHANGE_CONSEQUENCE: Record<WorkspaceRole, string> = {
  OWNER: 'Owners control billing, other owners and can delete the workspace. Only choose this for people you fully trust.',
  ADMIN: 'Admins can see and change every app and invite members.',
  MEMBER: 'Members only see the apps you give them on the App access tab, so check that after this change.',
};

/**
 * The workspace roles as options for `MemberRoleSelect`.
 *
 * @example
 * <MemberRoleSelect email={m.email} currentRole={m.role} roles={workspaceRoleOptions(assignableRoles('OWNER'))} />
 */
export function workspaceRoleOptions(roles: readonly WorkspaceRole[]): { value: string; label: string; title: string; consequence: string }[] {
  return roles.map((r) => ({ value: r, label: ROLE_LABEL[r], title: ROLE_SUMMARY[r], consequence: ROLE_CHANGE_CONSEQUENCE[r] }));
}

/** What each role can and cannot do, for the role guide. */
export const ROLE_ABILITIES: Record<WorkspaceRole, { can: string[]; cannot: string[] }> = {
  OWNER: {
    can: ['Everything an admin can', 'Add, remove and change other owners', 'Rename or delete the workspace'],
    cannot: [],
  },
  ADMIN: {
    can: ['See and change every app', 'Invite and remove members', 'Decide which apps members can use'],
    cannot: ['Manage owners or other admins', 'Delete the workspace'],
  },
  MEMBER: {
    can: ['Use the apps you give them access to'],
    cannot: ['See other apps', 'Invite people', 'Change workspace settings'],
  },
};

/**
 * @example
 * roleLabel('ADMIN') // 'Admin'
 */
export function roleLabel(role: string): string {
  return ROLE_LABEL[role as WorkspaceRole] ?? role;
}

/** The roles `actor` may hand out: an admin manages members only. */
export function assignableRoles(actor: string): WorkspaceRole[] {
  if (actor === 'OWNER') return [...WORKSPACE_ROLES];
  if (actor === 'ADMIN') return ['MEMBER'];
  return [];
}
