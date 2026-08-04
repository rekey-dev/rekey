/**
 * Panel analytics — a thin, typed wrapper over gtag (GA4).
 *
 * The panel is server-components + server-actions, so most "events" are the
 * RESULT of a server action that ends in redirect(). gtag only runs in the
 * browser, so those actions can't call it directly. Pattern instead: the action
 * appends a short `?e=<flag>` to its success redirect, and the client
 * <TrackFlag/> (mounted once in the root layout) maps the flag → event, fires
 * it, then strips the param so a refresh/back doesn't double-count.
 *
 * Page-view-style events (login/register viewed, panel access) fire from
 * <TrackView/> on mount. Pure client interactions (copy) call track() directly.
 *
 * Everything is a safe no-op when gtag is absent — dev, before the GA script
 * loads, or if the visitor blocks it.
 */

declare global {
  interface Window {
    gtag?: (command: 'event' | 'config' | 'js' | 'set', ...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/** Canonical event names. snake_case to match GA4 convention. */
export const AnalyticsEvent = {
  // auth + session lifecycle
  LoginPageView: 'login_page_view',
  RegisterPageView: 'register_page_view',
  UserRegistered: 'user_registered',
  UserLoggedIn: 'user_logged_in',
  UserLoggedOut: 'user_logged_out',
  PanelAccess: 'panel_access',
  // workspace
  WorkspaceCreated: 'workspace_created',
  /** Emitted when the deployment refuses an additional workspace (WORKSPACE_CREATION=disabled). */
  WorkspaceCreateRefused: 'workspace_create_refused',
  WorkspaceSwitched: 'workspace_switched',
  // product interactions
  ApplicationCreated: 'application_created',
  ApiKeyCreated: 'api_key_created',
  ApiKeyRevoked: 'api_key_revoked',
  PlanCreated: 'plan_created',
  CouponCreated: 'coupon_created',
  WebhookCreated: 'webhook_created',
  TeamMemberInvited: 'team_member_invited',
  CopyClicked: 'copy_clicked',
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvent)[keyof typeof AnalyticsEvent];

/** Fire a GA4 event. No-op if gtag isn't on the page yet (or at all). */
export function track(event: AnalyticsEventName, params?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  window.gtag?.('event', event, params ?? {});
}

/**
 * Maps a one-shot success-redirect flag (`?e=<flag>`) to the event it fires.
 * Flags are kept short so they don't bloat URLs. <TrackFlag/> consumes this.
 * To add a new server-action event: add a flag here, then append `?e=<flag>`
 * to that action's success redirect.
 */
export const FLAG_EVENTS: Record<
  string,
  { event: AnalyticsEventName; params?: Record<string, unknown> }
> = {
  signup: { event: AnalyticsEvent.UserRegistered },
  login: { event: AnalyticsEvent.UserLoggedIn, params: { method: 'password' } },
  login_passkey: { event: AnalyticsEvent.UserLoggedIn, params: { method: 'passkey' } },
  login_oauth: { event: AnalyticsEvent.UserLoggedIn, params: { method: 'oauth' } },
  login_cloud: { event: AnalyticsEvent.UserLoggedIn, params: { method: 'cloud' } },
  login_mfa: { event: AnalyticsEvent.UserLoggedIn, params: { method: 'mfa' } },
  logout: { event: AnalyticsEvent.UserLoggedOut },
  ws_created: { event: AnalyticsEvent.WorkspaceCreated },
  ws_create_disabled: { event: AnalyticsEvent.WorkspaceCreateRefused },
  ws_switched: { event: AnalyticsEvent.WorkspaceSwitched },
  app_created: { event: AnalyticsEvent.ApplicationCreated },
  apikey_created: { event: AnalyticsEvent.ApiKeyCreated },
  apikey_revoked: { event: AnalyticsEvent.ApiKeyRevoked },
  plan_created: { event: AnalyticsEvent.PlanCreated },
  coupon_created: { event: AnalyticsEvent.CouponCreated },
  webhook_created: { event: AnalyticsEvent.WebhookCreated },
  member_invited: { event: AnalyticsEvent.TeamMemberInvited },
};
