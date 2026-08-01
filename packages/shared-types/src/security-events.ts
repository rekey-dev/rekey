/**
 * Security-event types and their human labels — the single definition, next to
 * the package every consumer already depends on.
 *
 * ## Why this is here rather than in the panel
 *
 * The API emits these as bare string literals at ~62 call sites, typed as
 * `type: string` in `SecurityEventInput`, in the DTO, and in the Prisma column.
 * The operator panel therefore carried a hand-written mirror of the map so it
 * could render "End-user signed in" instead of `user.signed_in`. A mirror of a
 * list nobody owns drifts by construction: the panel's first version covered 10
 * of them, so 44 rendered the raw key twice — once as the value and once as its
 * own label — and the Event-type filter could not select any of the 44 either.
 * Three types a later revision guessed at turned out not to exist API-side.
 *
 * So the map lives with the shared types both sides already import. `EVENT_TYPE`
 * gives the emit sites a constant to reference instead of a literal, and
 * `SecurityEventType` makes the map exhaustive — a new event added to the union
 * without a label is a compile error, which is the whole point.
 *
 * Two pairs differ only by REST-vs-MCP provenance and read like typos. They are
 * not:
 *   - `app.plan_entitlement_updated` (REST) / `app.plan_entitlements_updated` (MCP)
 *   - `app.billing_credentials_updated` (REST) / `app.billing_credentials_configured` (MCP)
 */

/**
 * Every event type the API can emit, grouped as the emitters group them.
 *
 * The values ARE the contract — they are persisted in `security_events.type`
 * and appear in `?type=` filters, so renaming one is a breaking change to
 * stored data, not a refactor.
 */
export const SECURITY_EVENT_LABEL = {
  // ── Operator account lifecycle ──
  'operator.sign_in': 'Operator signed in',
  'operator.session_revoked': 'Operator session revoked',
  'operator.sign_out_everywhere': 'Operator signed out everywhere',
  'operator.api_token.created': 'Operator API token created',
  'operator.api_token.revoked': 'Operator API token revoked',
  'operator.invite_redeemed': 'Operator invite redeemed',

  // ── Application configuration ──
  'app.created': 'Application created',
  'app.auth_config_updated': 'Auth settings updated',
  'app.access_updated': 'Access controls updated',
  'app.api_key.created': 'API key created',
  'app.api_key.revoked': 'API key revoked',
  'app.sessions_rotated': 'App sessions rotated (kill-switch)',
  'app.public_key.rotated': 'Publishable key rotated',
  'app.portal_config_updated': 'Hosted portal settings updated',
  'app.ip_blocked': 'Request blocked by IP allowlist',
  'app.origin_blocked': 'Request blocked by CORS origin allowlist',

  // ── Billing configuration ──
  'app.billing_toggled': 'Billing switched on or off',
  'app.billing_credentials_updated': 'Billing provider credentials updated',
  'app.billing_credentials_configured': 'Billing provider configured (via MCP)',
  'app.billing_credentials_deleted': 'Billing provider credentials deleted',
  'app.plan_created': 'Plan created',
  'app.plan_updated': 'Plan updated',
  'app.plan_active_changed': 'Plan activated or deactivated',
  'app.plan_entitlement_updated': 'Plan entitlement updated',
  'app.plan_entitlement_removed': 'Plan entitlement removed',
  'app.plan_entitlements_updated': 'Plan entitlements replaced (via MCP)',
  'app.coupon_created': 'Coupon created',
  'app.coupon_updated': 'Coupon updated',
  'app.subscription_canceled': 'Subscription canceled by operator',
  'app.webhook_endpoint_created': 'Webhook endpoint created',
  'app.webhook_endpoint_updated': 'Webhook endpoint updated',

  // ── End-user actions (the end-user is the actor) ──
  'user.signed_up': 'End-user signed up',
  'user.signed_in': 'End-user signed in',
  // The two failure counterparts of `user.signed_in`. Without them, "why can't
  // this user sign in?" had no answer in the panel at all: the only record of a
  // failed attempt was a Redis counter with a TTL.
  'user.sign_in_failed': 'End-user sign-in failed',
  'user.locked_out': 'End-user locked out (too many failed attempts)',
  'user.email_verified': 'End-user verified their email',
  'user.password_reset': 'End-user reset their password',
  'user.password_changed': 'End-user changed their password',
  'user.passkey_added': 'End-user added a passkey',
  'user.passkey_removed': 'End-user removed a passkey',
  'user.sessions_revoked': 'End-user revoked their sessions',

  // ── Operator actions ON an end-user ──
  'end_user.erased': 'End-user erased (GDPR)',
  'end_user.delete_blocked': 'End-user deletion blocked',
  'end_user.deleted': 'End-user deleted',
  'end_user.data_exported': 'End-user data exported',

  // ── Workspace / team ──
  'workspace.member_invited': 'Teammate invited',
  'workspace.invitation_revoked': 'Invitation revoked',
  'workspace.member_role_changed': 'Teammate role changed',
  'workspace.member_removed': 'Teammate removed',
  'member.app_grant_set': 'Application access granted to member',
  'member.app_grant_removed': 'Application access removed from member',

  // ── Deployment administration ──
  'admin.operator_invite.minted': 'Operator invite minted',
  'admin.operator_invite.revoked': 'Operator invite revoked',
  'license.org_key_rotated': 'Organization licence key rotated',
  'auth.email_delivery_failed': 'Outbound email failed to send',
  'system.dependency_unavailable': 'A dependency was unavailable',
} as const satisfies Record<string, string>;

/** Union of every event type the API emits. */
export type SecurityEventType = keyof typeof SECURITY_EVENT_LABEL;

/**
 * The event types as named constants, for emit sites that would otherwise
 * write a bare literal. `EVENT_TYPE['user.locked_out']` is checked; the literal
 * is not.
 */
export const SECURITY_EVENT_TYPES = Object.keys(SECURITY_EVENT_LABEL) as SecurityEventType[];

/**
 * Label for one event type.
 *
 * Takes `string`, not `SecurityEventType`, on purpose: the value comes back
 * from the database as a bare string, and a row written by a NEWER API than the
 * client reading it is exactly the case that has to degrade well. An unknown
 * key is humanised — `app.plan_archived` → "Plan archived" — rather than
 * printed raw and shown twice.
 */
export function humanizeSecurityEventType(type: string): string {
  const known = (SECURITY_EVENT_LABEL as Record<string, string>)[type];
  if (known !== undefined) return known;
  // Drop the namespace, underscores (and any `.` inside the tail, as in
  // `api_key.created`) to spaces, sentence-case.
  const tail = type.includes('.') ? type.slice(type.indexOf('.') + 1) : type;
  const words = tail.replace(/[._]+/g, ' ').trim();
  if (words === '') return type;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Options for an Event-type `<select>`, sorted by label. */
export function securityEventTypeOptions(): Array<{ value: string; label: string }> {
  return Object.entries(SECURITY_EVENT_LABEL)
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
