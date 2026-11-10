/** What the authorization pages say when something stops them. Each line names what to do next. */

export const AUTHORIZE_EXPIRED_HEADING = 'This sign-in request has expired';
export const AUTHORIZE_EXPIRED_COPY =
  'A request lasts 15 minutes and works once. Go back to the app that sent you here and sign in from it again.';

/** @example authorizeErrorCopy('ORGANIZATION_NOT_MEMBER'); // 'You can no longer act for that organization. …' */
export function authorizeErrorCopy(code: string): string {
  switch (code) {
    case 'AUTHORIZATION_REQUEST_UNKNOWN':
    case 'INVALID_GRANT_REQUEST':
      return AUTHORIZE_EXPIRED_COPY;
    case 'ORGANIZATION_NOT_MEMBER':
    case 'ORGANIZATION_ROLE_DISABLED':
      return 'You can no longer act for that organization. Choose another account and press Allow again.';
    case 'RATE_LIMITED':
      return 'Too many attempts. Wait a minute, then press Allow or Cancel again.';
    case 'NETWORK_ERROR':
      return 'The sign-in service did not answer. Wait a moment, then press Allow or Cancel again.';
    default:
      return 'That did not work. Press Allow or Cancel again, or start again from the app.';
  }
}
