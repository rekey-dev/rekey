/**
 * Words on the organization and invitation pages.
 *
 * Pure and runtime-neutral: pages, actions and tests import it.
 */

export const ORGANIZATION_DONE = {
  switched: 'switched',
  personal: 'personal',
  created: 'created',
  roleChanged: 'role_changed',
  removed: 'removed',
  left: 'left',
  revoked: 'revoked',
  joined: 'joined',
} as const;

const DONE_COPY: Readonly<Record<string, string>> = {
  [ORGANIZATION_DONE.switched]: 'That organization is now active. Billing and plan details follow it.',
  [ORGANIZATION_DONE.personal]: 'You are now using your personal account.',
  [ORGANIZATION_DONE.created]: 'Your organization was created, and you are its owner.',
  [ORGANIZATION_DONE.roleChanged]: 'The role was changed.',
  [ORGANIZATION_DONE.removed]: 'The member was removed.',
  [ORGANIZATION_DONE.left]: 'You left the organization.',
  [ORGANIZATION_DONE.revoked]: 'The invitation was revoked, so its link no longer works.',
  [ORGANIZATION_DONE.joined]: 'You joined the organization.',
};

export function organizationDoneCopy(done: string): string | null {
  return Object.prototype.hasOwnProperty.call(DONE_COPY, done) ? DONE_COPY[done]! : null;
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  missing: 'Fill in the field, then try again.',
  ORGANIZATIONS_NOT_ENABLED: 'This app does not let you create organizations.',
  ORGANIZATION_SLUG_TAKEN: 'An organization with that name already exists here. Choose another name.',
  ORGANIZATION_SLUG_INVALID: 'Use letters or numbers in the name.',
  ORGANIZATION_NOT_MEMBER: 'You are not a member of that organization any more.',
  ORGANIZATION_ROLE_INSUFFICIENT: 'Your role in this organization does not allow that.',
  ORGANIZATION_ROLE_UNKNOWN: 'That role no longer exists. Reload the page and choose another.',
  ORGANIZATION_ROLE_DISABLED: 'That role has been turned off. Reload the page and choose another.',
  ORGANIZATION_LAST_OWNER: 'An organization needs an owner. Make another member an owner first.',
  ORGANIZATION_OWNER_CANNOT_LEAVE: 'Owners cannot leave. Make another member an owner first.',
  ORGANIZATION_MEMBER_NOT_FOUND: 'That person is no longer a member.',
  ORGANIZATION_ALREADY_MEMBER: 'That person is already a member.',
  ORGANIZATION_INVITATION_NOT_FOUND: 'That invitation no longer exists.',
  ORGANIZATION_INVITATION_NOT_PENDING: 'That invitation was already accepted or revoked. Reload the page to see who is still invited.',
};

export function organizationErrorCopy(code: string): string {
  if (Object.prototype.hasOwnProperty.call(ERROR_COPY, code)) return ERROR_COPY[code]!;
  return 'That did not work. Try again, and if it keeps happening, contact support.';
}

const INVITATION_ERRORS: Readonly<Record<string, string>> = {
  ORGANIZATION_INVITATION_EMAIL_MISMATCH:
    'This invitation was sent to a different email address. Sign out, then sign in with the address it was sent to.',
  ORGANIZATION_INVITATION_NOT_USABLE: 'This invitation was already used or revoked. Ask for a new one.',
  ORGANIZATION_INVITATION_EXPIRED: 'This invitation expired. Ask for a new one.',
  ORGANIZATION_INVITATION_WRONG_APPLICATION: 'This invitation is for a different app.',
  ORGANIZATION_ROLE_DISABLED: 'The role this invitation offers has been turned off. Ask for a new one.',
};

export function invitationErrorCopy(code: string): string {
  if (Object.prototype.hasOwnProperty.call(INVITATION_ERRORS, code)) return INVITATION_ERRORS[code]!;
  return 'The invitation could not be accepted. Try again, and if it keeps happening, ask for a new one.';
}

/** Refusals after which the invitation can never be accepted, so its cookie is dropped. */
export function invitationIsSpent(code: string): boolean {
  return (
    code === 'ORGANIZATION_INVITATION_NOT_USABLE' ||
    code === 'ORGANIZATION_INVITATION_EXPIRED' ||
    code === 'ORGANIZATION_INVITATION_WRONG_APPLICATION'
  );
}

const BUILT_IN_ROLES: Readonly<Record<string, string>> = { OWNER: 'Owner', ADMIN: 'Admin', MEMBER: 'Member' };

/** A role name as a person reads it. Custom names are the operator's words and stay as written. */
export function roleLabel(role: string): string {
  return BUILT_IN_ROLES[role] ?? role;
}

/**
 * The slug the API wants, made from the name the customer typed.
 *
 * @example
 * organizationSlug('Acme Labs, Inc.'); // 'acme-labs-inc'
 */
export function organizationSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * An address masked the way the API masks one it shows before sign-in: the
 * first character and the domain. Lets a page compare the signed-in address
 * with an invitation's masked one without ever seeing the invited address.
 *
 * @example
 * maskedEmail('riley@northwind.example'); // 'r***@northwind.example'
 */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}
