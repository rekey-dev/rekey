/**
 * What "Send confirmation email" can come back with, as the operator reads
 * it. Shared by the action (which only passes on a code it has copy for) and
 * the page that renders it.
 */
export const CONFIRM_SEND_ERRORS: Readonly<Record<string, string>> = {
  AUTH_EMAIL_RECIPIENT_CAPPED:
    'This address has been sent as many emails as it may have for now. The confirmation emails already in your inbox still work; otherwise try again in an hour.',
  OPERATOR_CONFIRMATION_EMAIL_UNAVAILABLE:
    'This deployment cannot send email. Sign out and sign in with Google or GitHub to confirm the address; that removes your current password.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  unknown: 'Could not send the confirmation email. Try again in a moment.',
};
