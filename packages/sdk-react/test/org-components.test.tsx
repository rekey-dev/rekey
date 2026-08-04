/**
 * Organization widgets — <OrganizationSwitcher>, <CreateOrganization>,
 * <OrganizationProfile>.
 *
 * Load-bearing behavior:
 *   - The org-billing nudge: with billingSubject='org' and no active org, the
 *     switcher must steer the user toward a team (and must not present a "Switch"
 *     that goes nowhere when there are no teams to switch to).
 *   - OrganizationProfile gates the manage affordances (role change / remove /
 *     invite) to OWNER/ADMIN viewers, and the mutation forms must carry the
 *     documented field contract (endUserId, role, invitationId) + hidden fields.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  OrganizationSwitcher,
  CreateOrganization,
  OrganizationProfile,
  type OrgSummary,
  type OrgMember,
  type OrgInvitation,
} from '../src/org-components.js';

const noop = vi.fn();

const ORGS: OrgSummary[] = [
  { id: 'org_1', name: 'Acme', role: 'OWNER' },
  { id: 'org_2', name: 'Globex', role: 'MEMBER' },
];

describe('<OrganizationSwitcher> — personal vs org billing', () => {
  it('offers the Personal option when billing is per-user', () => {
    render(<OrganizationSwitcher organizations={ORGS} switchAction={noop} billingSubject="user" />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.textContent);
    expect(opts).toContain('Personal');
  });

  it('hides the Personal option and nudges to a team when billing is per-org', () => {
    render(<OrganizationSwitcher organizations={ORGS} switchAction={noop} billingSubject="org" activeOrganizationId={null} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const opts = Array.from(select.options).map((o) => o.textContent);
    expect(opts).not.toContain('Personal');
    // The subtitle nudge is present.
    expect(screen.getByText(/select or create a team/i)).not.toBeNull();
  });

  it('exposes a Create-team affordance when a createAction is supplied', () => {
    render(<OrganizationSwitcher organizations={ORGS} switchAction={noop} createAction={noop} billingSubject="user" />);
    expect(screen.getByRole('button', { name: /create team/i })).not.toBeNull();
  });

  /**
   * BUG PROBE: per-org billing with NO teams yet. The user cannot switch (there
   * is nothing to switch to) — the only correct path is "create a team". A live
   * "Switch" button here submits orgId="" which clears the active org, i.e. a
   * dead/misleading control. We assert the desired behavior: no dead Switch.
   */
  it('does not present a dead Switch button when org billing requires a team but none exist', () => {
    render(
      <OrganizationSwitcher
        organizations={[]}
        switchAction={noop}
        createAction={noop}
        billingSubject="org"
        activeOrganizationId={null}
      />,
    );
    expect(screen.queryByRole('button', { name: /^switch$/i })).toBeNull();
    // Create must still be offered so the user has a way forward.
    expect(screen.getByRole('button', { name: /create team/i })).not.toBeNull();
  });
});

describe('<CreateOrganization>', () => {
  it('renders a name field and a create button posting to the action', () => {
    const { container } = render(<CreateOrganization action={noop} />);
    expect(container.querySelector('input[name="name"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /create team/i })).not.toBeNull();
  });

  it('shows a slug field only when withSlug is set', () => {
    const { container, rerender } = render(<CreateOrganization action={noop} />);
    expect(container.querySelector('input[name="slug"]')).toBeNull();
    rerender(<CreateOrganization action={noop} withSlug />);
    expect(container.querySelector('input[name="slug"]')).not.toBeNull();
  });

  it('surfaces an error via an alert role', () => {
    render(<CreateOrganization action={noop} error="Name taken" />);
    expect(screen.getByRole('alert').textContent).toContain('Name taken');
  });
});

describe('<OrganizationProfile> — viewer role gating', () => {
  // The two ids are DELIBERATELY different, and deliberately not
  // interchangeable-looking. `OrganizationMemberDto` carries both: `id` is the
  // membership row, `endUserId` is the user the mutation endpoints address.
  // The old fixture used a single `id: 'eu_1'` — an end-user-shaped value in
  // the membership slot — which is how a component posting `m.id` into the
  // `endUserId` field looked correct in every assertion for two releases.
  const members: OrgMember[] = [
    { id: 'om_1', endUserId: 'eu_1', email: 'owner@x.com', role: 'OWNER' },
    { id: 'om_2', endUserId: 'eu_2', email: 'member@x.com', role: 'MEMBER' },
  ];

  it('shows the invite form + manage controls for an OWNER viewer', () => {
    const { container } = render(
      <OrganizationProfile
        organization={{ id: 'org_1', name: 'Acme' }}
        members={members}
        viewerRole="OWNER"
        inviteAction={noop}
        setRoleAction={noop}
        removeAction={noop}
      />,
    );
    // Invite form carries email + role.
    expect(container.querySelector('input[name="email"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: /^invite$/i })).not.toBeNull();
    // Manage controls present — one Remove per member.
    expect(screen.getAllByRole('button', { name: /remove/i }).length).toBe(members.length);
    // Role-change selects carry the endUserId hidden field.
    expect(container.querySelector('input[name="endUserId"]')).not.toBeNull();
  });

  it('posts endUserId — the END-USER id, not the membership row id', () => {
    // The regression this guards: `<input name="endUserId" value={m.id} />`.
    // Asserting the field EXISTS (the test above) passes either way; only the
    // value distinguishes a working role change from a silent no-op.
    const { container } = render(
      <OrganizationProfile
        organization={{ id: 'org_1', name: 'Acme' }}
        members={members}
        viewerRole="OWNER"
        setRoleAction={noop}
        removeAction={noop}
      />,
    );

    const posted = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[name="endUserId"]'),
    ).map((i) => i.value);

    // One set-role form + one remove form per member.
    expect(posted.length).toBe(members.length * 2);
    expect(new Set(posted)).toEqual(new Set(['eu_1', 'eu_2']));
    // And specifically NOT the membership row ids.
    expect(posted).not.toContain('om_1');
    expect(posted).not.toContain('om_2');
  });

  it('hides invite + manage controls for a MEMBER viewer', () => {
    render(
      <OrganizationProfile
        organization={{ id: 'org_1', name: 'Acme' }}
        members={members}
        viewerRole="MEMBER"
        inviteAction={noop}
        setRoleAction={noop}
        removeAction={noop}
      />,
    );
    expect(screen.queryByRole('button', { name: /^invite$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    // Members are still listed (read-only), shown with a role badge.
    expect(screen.queryByText('member@x.com')).not.toBeNull();
    expect(screen.queryByText('OWNER')).not.toBeNull();
  });

  it('appends hiddenFields to every mutation form', () => {
    const { container } = render(
      <OrganizationProfile
        organization={{ id: 'org_1', name: 'Acme' }}
        members={members}
        viewerRole="ADMIN"
        inviteAction={noop}
        removeAction={noop}
        hiddenFields={{ orgId: 'org_1' }}
      />,
    );
    const orgFields = container.querySelectorAll('input[name="orgId"]');
    // At least the invite form + each member's remove form carry the org id.
    expect(orgFields.length).toBeGreaterThan(0);
    orgFields.forEach((f) => expect((f as HTMLInputElement).value).toBe('org_1'));
  });

  it('renders pending invitations with a revoke control for managers', () => {
    const invitations: OrgInvitation[] = [{ id: 'inv_1', email: 'pending@x.com', role: 'MEMBER' }];
    const { container } = render(
      <OrganizationProfile
        organization={{ id: 'org_1', name: 'Acme' }}
        members={members}
        invitations={invitations}
        viewerRole="OWNER"
        revokeInviteAction={noop}
      />,
    );
    expect(screen.queryByText('pending@x.com')).not.toBeNull();
    expect(screen.getByRole('button', { name: /revoke/i })).not.toBeNull();
    expect(container.querySelector('input[name="invitationId"]')).not.toBeNull();
  });

  it('reports the member count and viewer role in the header', () => {
    render(
      <OrganizationProfile organization={{ id: 'org_1', name: 'Acme' }} members={members} viewerRole="OWNER" />,
    );
    expect(screen.getByText(/2 members/i)).not.toBeNull();
  });

  it('gives every role select + the invite email an accessible name (a11y)', () => {
    render(
      <OrganizationProfile
        organization={{ id: 'org_1', name: 'Acme' }}
        members={members}
        viewerRole="OWNER"
        inviteAction={noop}
        setRoleAction={noop}
      />,
    );
    // Per-member role selects are labelled by the member they govern.
    expect(screen.getByRole('combobox', { name: /role for owner@x\.com/i })).not.toBeNull();
    expect(screen.getByRole('combobox', { name: /role for member@x\.com/i })).not.toBeNull();
    // Invite controls are labelled.
    expect(screen.getByRole('combobox', { name: /invite role/i })).not.toBeNull();
    expect(screen.getByRole('textbox', { name: /invite teammate by email/i })).not.toBeNull();
  });
});
