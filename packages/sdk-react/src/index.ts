/**
 * @rekey.dev/react — React hooks + headless components for end-user auth.
 *
 * @example
 * ```tsx
 * // Server (Next.js App Router root layout)
 * const user = await getCurrentUserFromCookie();
 * return (
 *   <RekeyProvider apiUrl={env.RELIPAY_URL} initialUser={user} accessToken={user?.accessToken ?? null}>
 *     {children}
 *   </RekeyProvider>
 * );
 *
 * // Client component
 * import { useUser, SignedIn, SignedOut } from '@rekey.dev/react';
 *
 * function Header() {
 *   const { user } = useUser();
 *   return (
 *     <>
 *       <SignedIn>Hi, {user!.email}</SignedIn>
 *       <SignedOut><a href="/sign-in">Sign in</a></SignedOut>
 *     </>
 *   );
 * }
 * ```
 */

export { RekeyProvider } from './context.js';
export type { RekeyContextValue, RekeyProviderProps } from './context.js';
export { useUser, useRelipay } from './hooks.js';
export { SignedIn, SignedOut, Loading } from './components.js';
export { RekeyBrowserClient, RekeyError } from './client.js';
export type {
  ReliPayBrowserConfig,
  EndUserDto,
  EntitlementsDto,
  PortalPaymentDto,
  ProvidersListDto,
  BillingProviderInfoDto,
  BillingProviderCapabilities,
  BillingProvider,
} from './client.js';
export { mcpConnectionInfo } from './mcp.js';
export type { McpConnectionInfo } from './mcp.js';

// ── Drop-in UI components (Clerk-style) ──
// Theming primitives.
export { Themed, useAppearance } from './theme.js';
export type {
  Appearance,
  AppearanceProp,
  AppearanceVariables,
  AppearanceElement,
} from './theme.js';

// Control components — gate UI on auth state / entitlements.
export { Protect, RekeyLoading, RekeyLoaded } from './control.js';
export type { ProtectProps, ProtectAuthorization } from './control.js';

// Auth widgets.
export {
  SignIn,
  SignUp,
  UserButton,
  SignInButton,
  SignUpButton,
  SignOutButton,
} from './auth-components.js';
export type {
  SignInProps,
  SignUpProps,
  UserButtonProps,
  NavButtonProps,
  OAuthProvider,
  FormAction,
} from './auth-components.js';

// Organization widgets.
export {
  OrganizationSwitcher,
  CreateOrganization,
  OrganizationProfile,
} from './org-components.js';
export type {
  OrganizationSwitcherProps,
  CreateOrganizationProps,
  OrganizationProfileProps,
  OrgSummary,
  OrgMember,
  OrgInvitation,
} from './org-components.js';

// Billing widgets.
export { PricingTable, CheckoutButton } from './billing-components.js';
export type {
  PricingTableProps,
  CheckoutButtonProps,
  PricingPlan,
} from './billing-components.js';

// Provider picker — let the end-user choose a billing provider ("Pay with…").
export { ProviderPicker } from './provider-picker.js';
export type { ProviderPickerProps, ProviderOption } from './provider-picker.js';
