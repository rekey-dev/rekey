/**
 * Organization widgets — `<OrganizationSwitcher>` / `<CreateOrganization>` /
 * `<OrganizationProfile>`, Clerk-shaped.
 *
 * ── Data + mutation model ──
 *
 * The org endpoints (`/api/v1/users/me/organizations/*`) are secret-key guarded,
 * so the browser cannot list orgs / members or mutate them directly. As with the
 * auth widgets, these components are **render + delegate**:
 *
 *   - READ data (the user's orgs, the active org id, a team's members/invites)
 *     comes in as PROPS that the customer resolves server-side via `@rekey.dev/node`
 *     (`organizations.listMine`, `organizations.listMembers`, …).
 *   - WRITES (create, switch, invite, set-role, remove) are customer Server
 *     Actions passed via props and wired to `<form action={…}>`.
 *
 * Org-billing note: when the Application's `billingSubject === 'org'`, a user must
 * be inside a team before billing/usage resolve. `<OrganizationSwitcher>` accepts
 * `billingSubject` so it can nudge the user ("select a team to continue") and
 * `<OrganizationProfile>` is the place members get invited into that team.
 */

import * as React from 'react';
import { Themed, useCx, type AppearanceProp } from './theme.js';
import type { FormAction } from './auth-components.js';

/** Minimal org shape the switcher needs — matches `OrganizationWithRoleDto`. */
export interface OrgSummary {
  id: string;
  name: string;
  /** The caller's role, when known. */
  role?: string;
}

/** Minimal member shape — matches `OrganizationMemberDto`. */
export interface OrgMember {
  id: string;
  email: string;
  role: string;
}

/** Minimal pending-invitation shape — matches `OrganizationInvitationDto`. */
export interface OrgInvitation {
  id: string;
  email: string;
  role: string;
}

// ---------------------------------------------------------------------------
// <OrganizationSwitcher>
// ---------------------------------------------------------------------------

export interface OrganizationSwitcherProps {
  /** The user's organizations (resolve via `organizations.listMine` server-side). */
  organizations: OrgSummary[];
  /** The currently active org id, or null for the personal workspace. */
  activeOrganizationId?: string | null;
  /**
   * Server Action that switches the active org. Receives `orgId` in FormData
   * (empty string = clear active / back to personal). Wire it to mint a fresh
   * org-scoped token and rotate the cookie (`organizations.switch`).
   */
  switchAction: FormAction;
  /** Server Action to create a new org (reads `name`). Enables the "Create team" affordance. */
  createAction?: FormAction;
  /** When the app bills per-org, pass `'org'` to surface the "select a team" nudge. */
  billingSubject?: 'user' | 'org';
  /** Allow switching back to a personal (no-org) workspace. Ignored when billingSubject==='org'. */
  allowPersonal?: boolean;
  /** Heading. */
  label?: string;
  appearance?: AppearanceProp;
  className?: string;
}

function OrganizationSwitcherBody({
  organizations,
  activeOrganizationId = null,
  switchAction,
  createAction,
  billingSubject = 'user',
  allowPersonal = true,
  label = 'Workspace',
}: OrganizationSwitcherProps): React.JSX.Element {
  const cx = useCx();
  const orgRequired = billingSubject === 'org';
  const showPersonal = allowPersonal && !orgRequired;
  const active = organizations.find((o) => o.id === activeOrganizationId) ?? null;
  const [creating, setCreating] = React.useState(false);

  // Is there anything to switch *to*? The selectable set is the real orgs plus
  // the Personal option (when shown). When an app bills per-team and the user
  // has no teams yet, there's nothing to switch among — rendering a live
  // "Switch" there is a dead control (it would post an empty orgId, clearing the
  // active org, which org-billing forbids). In that case we drop the switch form
  // and steer the user to "Create team" instead.
  const hasSwitchTargets = organizations.length > 0 || showPersonal;

  return (
    <div className={cx('rekey-card', 'card')}>
      <div className={cx('rekey-header', 'header')}>
        <h2 className={cx('rekey-title', 'title')} style={{ fontSize: '1rem' }}>{label}</h2>
        {orgRequired && !activeOrganizationId && (
          <p className={cx('rekey-subtitle', 'subtitle')}>
            This app bills per team — select or create a team to continue.
          </p>
        )}
      </div>

      {/* Current selection + a native select to switch. Suppressed when there's
          nothing to switch to (per-org billing, no teams yet) — see above. */}
      {hasSwitchTargets ? (
        <form action={switchAction} className="rekey-stack">
          <label className={cx('rekey-label', 'label')} htmlFor="rekey-org-select">
            {active ? `Current: ${active.name}` : orgRequired ? 'No team selected' : 'Personal workspace'}
          </label>
          <div className="rekey-row">
            <select
              id="rekey-org-select"
              name="orgId"
              defaultValue={activeOrganizationId ?? ''}
              className={cx('rekey-select', 'input')}
            >
              {showPersonal && <option value="">Personal</option>}
              {orgRequired && !activeOrganizationId && <option value="" disabled>Select a team…</option>}
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {o.role ? ` (${o.role.toLowerCase()})` : ''}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className={cx('rekey-btn rekey-btn-secondary', 'buttonSecondary')}
              style={{ flexShrink: 0 }}
            >
              Switch
            </button>
          </div>
        </form>
      ) : null}

      {createAction && (
        <>
          <div className={cx('rekey-divider', 'divider')}>or</div>
          {creating ? (
            <form action={createAction} className="rekey-row">
              <input
                name="name"
                required
                autoFocus
                placeholder="New team name"
                className={cx('rekey-input', 'input')}
              />
              <button
                type="submit"
                className={cx('rekey-btn rekey-btn-primary', 'buttonPrimary')}
                style={{ flexShrink: 0 }}
              >
                Create
              </button>
            </form>
          ) : (
            <button
              type="button"
              className={cx('rekey-btn rekey-btn-secondary rekey-btn-block', 'buttonSecondary')}
              onClick={() => setCreating(true)}
            >
              Create team
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Pick / switch / create the active organization (Clerk's `<OrganizationSwitcher>`).
 * Reads the org list as a prop (server-resolved) and delegates switching +
 * creation to your Server Actions. Respects `billingSubject='org'` by nudging the
 * user to select a team when none is active.
 *
 * @example
 * ```tsx
 * <OrganizationSwitcher
 *   organizations={orgs}              // from organizations.listMine() server-side
 *   activeOrganizationId={activeOrgId}
 *   switchAction={switchOrgAction}    // your server action (organizations.switch)
 *   createAction={createOrgAction}
 *   billingSubject={config.billingSubject}
 * />
 * ```
 */
export function OrganizationSwitcher(props: OrganizationSwitcherProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <OrganizationSwitcherBody {...props} />
    </Themed>
  );
}

// ---------------------------------------------------------------------------
// <CreateOrganization>
// ---------------------------------------------------------------------------

export interface CreateOrganizationProps {
  /** Server Action that creates the org (reads `name`, optionally `slug`). */
  action: FormAction;
  /** Show a slug input alongside the name. Off by default (most apps derive it). */
  withSlug?: boolean;
  /** Error to surface (e.g. a name collision). */
  error?: React.ReactNode;
  title?: string;
  subtitle?: string;
  appearance?: AppearanceProp;
  className?: string;
}

function CreateOrganizationBody({
  action, withSlug = false, error,
  title = 'Create a team', subtitle,
}: CreateOrganizationProps): React.JSX.Element {
  const cx = useCx();
  return (
    <div className={cx('rekey-card', 'card')}>
      <div className={cx('rekey-header', 'header')}>
        <h2 className={cx('rekey-title', 'title')}>{title}</h2>
        {subtitle && <p className={cx('rekey-subtitle', 'subtitle')}>{subtitle}</p>}
      </div>
      {error && (
        <div role="alert" className={cx('rekey-alert rekey-alert-error', 'alert')}>{error}</div>
      )}
      <form action={action} className="rekey-stack">
        <div className="rekey-field">
          <label className={cx('rekey-label', 'label')} htmlFor="rekey-org-name">Team name</label>
          <input
            id="rekey-org-name" name="name" required autoFocus
            placeholder="Acme Inc." className={cx('rekey-input', 'input')}
          />
        </div>
        {withSlug && (
          <div className="rekey-field">
            <label className={cx('rekey-label', 'label')} htmlFor="rekey-org-slug">Slug</label>
            <input
              id="rekey-org-slug" name="slug"
              placeholder="acme" className={cx('rekey-input', 'input')}
            />
          </div>
        )}
        <button type="submit" className={cx('rekey-btn rekey-btn-primary rekey-btn-block', 'buttonPrimary')}>
          Create team
        </button>
      </form>
    </div>
  );
}

/**
 * Standalone "create a team" card (Clerk's `<CreateOrganization>`). Delegates to
 * your create Server Action.
 *
 * @example
 * ```tsx
 * <CreateOrganization action={createOrgAction} />
 * ```
 */
export function CreateOrganization(props: CreateOrganizationProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <CreateOrganizationBody {...props} />
    </Themed>
  );
}

// ---------------------------------------------------------------------------
// <OrganizationProfile>
// ---------------------------------------------------------------------------

const ROLES = ['MEMBER', 'ADMIN', 'OWNER'] as const;

export interface OrganizationProfileProps {
  /** The org being managed. */
  organization: OrgSummary;
  /** Current members (resolve via `organizations.listMembers` server-side). */
  members: OrgMember[];
  /** Pending invitations, if you surface them (resolve server-side). */
  invitations?: OrgInvitation[];
  /** The viewer's role — controls whether invite/manage affordances render. */
  viewerRole?: string;
  /** Server Action to invite a member (reads `email`, `role`). Enables the invite form. */
  inviteAction?: FormAction;
  /** Server Action to change a member's role (reads `endUserId`, `role`). */
  setRoleAction?: FormAction;
  /** Server Action to remove a member (reads `endUserId`). */
  removeAction?: FormAction;
  /** Server Action to revoke a pending invitation (reads `invitationId`). */
  revokeInviteAction?: FormAction;
  /** Optional hidden field name→value pairs added to every form (e.g. the org id). */
  hiddenFields?: Record<string, string>;
  title?: string;
  appearance?: AppearanceProp;
  className?: string;
}

function HiddenFields({ fields }: { fields?: Record<string, string> | undefined }): React.JSX.Element | null {
  if (!fields) return null;
  return (
    <>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

function canManage(role: string | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

function OrganizationProfileBody({
  organization, members, invitations = [], viewerRole,
  inviteAction, setRoleAction, removeAction, revokeInviteAction,
  hiddenFields, title,
}: OrganizationProfileProps): React.JSX.Element {
  const cx = useCx();
  const manage = canManage(viewerRole);
  const heading = title ?? `${organization.name} · Members`;

  return (
    <div className={cx('rekey-card', 'card')} style={{ maxWidth: '32rem' }}>
      <div className={cx('rekey-header', 'header')}>
        <h2 className={cx('rekey-title', 'title')}>{heading}</h2>
        <p className={cx('rekey-subtitle', 'subtitle')}>
          {members.length} member{members.length === 1 ? '' : 's'}
          {viewerRole ? ` · you are ${viewerRole.toLowerCase()}` : ''}
        </p>
      </div>

      {/* Member list */}
      <div className="rekey-stack">
        {members.map((m) => (
          <div key={m.id} className="rekey-member-row">
            <span>{m.email}</span>
            {manage && setRoleAction ? (
              <form action={setRoleAction} className="rekey-row rekey-spacer">
                <HiddenFields fields={hiddenFields} />
                <input type="hidden" name="endUserId" value={m.id} />
                <select name="role" defaultValue={m.role} aria-label={`Role for ${m.email}`} className={cx('rekey-select', 'input')} style={{ padding: '4px 8px', width: 'auto' }}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>
                  ))}
                </select>
                <button type="submit" className={cx('rekey-link', 'menuItem')}>Save</button>
              </form>
            ) : (
              <span className={cx('rekey-badge', 'badge') + ' rekey-spacer'}>{m.role}</span>
            )}
            {manage && removeAction && (
              <form action={removeAction}>
                <HiddenFields fields={hiddenFields} />
                <input type="hidden" name="endUserId" value={m.id} />
                <button type="submit" className="rekey-link" style={{ color: 'var(--rekey-color-danger)' }}>
                  Remove
                </button>
              </form>
            )}
          </div>
        ))}
      </div>

      {/* Pending invitations */}
      {invitations.length > 0 && (
        <>
          <div className={cx('rekey-label', 'label')} style={{ marginTop: 'var(--rekey-spacing)' }}>Pending invitations</div>
          <div className="rekey-stack">
            {invitations.map((inv) => (
              <div key={inv.id} className="rekey-member-row">
                <span>{inv.email}</span>
                <span className={cx('rekey-badge', 'badge') + ' rekey-spacer'}>{inv.role}</span>
                {manage && revokeInviteAction && (
                  <form action={revokeInviteAction}>
                    <HiddenFields fields={hiddenFields} />
                    <input type="hidden" name="invitationId" value={inv.id} />
                    <button type="submit" className="rekey-link" style={{ color: 'var(--rekey-color-danger)' }}>
                      Revoke
                    </button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Invite form (OWNER/ADMIN only) */}
      {manage && inviteAction && (
        <>
          <div className={cx('rekey-divider', 'divider')}>invite a teammate</div>
          <form action={inviteAction} className="rekey-row">
            <HiddenFields fields={hiddenFields} />
            <input
              name="email" type="email" required aria-label="Invite teammate by email"
              placeholder="teammate@example.com" className={cx('rekey-input', 'input')}
            />
            <select name="role" defaultValue="MEMBER" aria-label="Invite role" className={cx('rekey-select', 'input')} style={{ width: 'auto', flexShrink: 0 }}>
              {ROLES.map((r) => (
                <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>
              ))}
            </select>
            <button type="submit" className={cx('rekey-btn rekey-btn-primary', 'buttonPrimary')} style={{ flexShrink: 0 }}>
              Invite
            </button>
          </form>
        </>
      )}
    </div>
  );
}

/**
 * Manage a team's members + invitations (Clerk's `<OrganizationProfile>`). Reads
 * members/invitations as props (server-resolved) and delegates every mutation to
 * your Server Actions. Manage affordances render only for OWNER/ADMIN viewers.
 *
 * @example
 * ```tsx
 * <OrganizationProfile
 *   organization={{ id: org.id, name: org.name }}
 *   members={members}                 // organizations.listMembers() server-side
 *   viewerRole={myRole}
 *   inviteAction={inviteMemberAction}
 *   hiddenFields={{ orgId: org.id }}  // appended to each form
 * />
 * ```
 */
export function OrganizationProfile(props: OrganizationProfileProps): React.JSX.Element {
  return (
    <Themed appearance={props.appearance} className={props.className}>
      <OrganizationProfileBody {...props} />
    </Themed>
  );
}
