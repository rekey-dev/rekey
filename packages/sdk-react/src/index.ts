/**
 * @rekey.dev/react, React hooks + headless components for end-user auth.
 *
 * @example
 * ```tsx
 * // Server (Next.js App Router root layout)
 * const user = await getCurrentUserFromCookie();
 * return (
 *   <RekeyProvider apiUrl={env.REKEY_URL} initialUser={user} accessToken={user?.accessToken ?? null}>
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
export { useUser, useRekey } from './hooks.js';
export { useOAuthProviders } from './oauth-providers.js';
export { SignedIn, SignedOut, Loading } from './components.js';
export { RekeyBrowserClient, RekeyError } from './client.js';
export type {
  RekeyBrowserConfig,
  EndUserDto,
  CurrentUserDto,
  EndUserLicenseDto,
  FeatureCheckDto,
  PublicPlanDto,
  PublicPlanCheckoutDto,
  PublicPlanPriceDto,
  ResolvedPriceDto,
  PriceFallbackDto,
  PriceReason,
  CheckoutResultDto,
  CreateCheckoutRequest,
  ValidateCouponRequest,
  ValidateCouponResultDto,
  PublicCouponDto,
  SelfSubscriptionDto,
  EntitlementsDto,
  MeInclude,
  MeIncluded,
  MeIncludedFor,
  MeIncludedFields,
  PortalPaymentDto,
  ProvidersListDto,
  OAuthProvidersListDto,
  OAuthProviderSummaryDto,
  BillingProviderInfoDto,
  BillingProviderCapabilities,
  BillingProvider,
  TrialEligibilityDto,
  TrialEligibilityItemDto,
  TrialPolicyType,
  EndUserDeviceDto,
  DeviceLimitDetails,
  DeviceStatusType,
  UsageRemainingDto,
  UsageMeterRemainingDto,
  SelfCreditLedgerEntryDto,
  ContactListPublicDto,
  ListSubscribeRequest,
  ProfileStateDto,
  OnboardingStatus,
} from './client.js';
export { mcpConnectionInfo } from './mcp.js';
export type { McpConnectionInfo } from './mcp.js';

// ── Drop-in UI components (Clerk-style) ──
// Theming primitives.
export { Themed, RekeyStyles, useAppearance } from './theme.js';
export type {
  Appearance,
  AppearanceProp,
  AppearanceVariables,
  AppearanceElement,
} from './theme.js';

// Control components, gate UI on auth state / entitlements.
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
  PricingPlanPrice,
  PricingPlanResolvedPrice,
} from './billing-components.js';

// What a buyer is told about the price before they pay.
export { PriceFallbackNotice, CouponQuote } from './price-notices.js';
export type { PriceFallbackNoticeProps, CouponQuoteProps } from './price-notices.js';
/**
 * Money written by the currency registry, for the few places a page formats an
 * amount itself (a payment row, a subscription's price).
 *
 * @example
 * ```ts
 * formatMoney(payment.amount - payment.refundedAmount, payment.currency); // '$14.00'
 * priceFallbackMessage(checkout.priceFallback); // 'Prices in INR are not available yet. You will pay $19.00.'
 * ```
 */
export {
  formatMoney,
  minorUnitExponent,
  validatePriceAmount,
  sellableCurrencies,
  priceFallbackMessage,
} from '@rekey.dev/shared-types/currency';
export type { PriceFallbackSides } from '@rekey.dev/shared-types/currency';

// List forms: a newsletter or waitlist signup and a contact form.
export { NewsletterForm, ContactForm, useListSubscribe } from './list-components.js';
export type { ListFormProps, ListSubscribeValues, UseListSubscribe } from './list-components.js';

// Provider picker, let the end-user choose a billing provider ("Pay with…").
export { ProviderPicker } from './provider-picker.js';
export type { ProviderPickerProps, ProviderOption } from './provider-picker.js';
