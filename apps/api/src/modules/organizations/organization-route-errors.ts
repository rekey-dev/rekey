/**
 * The auth errors shared by every end-user organization route:
 * `requirePublishableOrSecretKey` + the scope (`auth:read` for GET,
 * `auth:write` otherwise) + `requireUserSession` all run as `onRequest` hooks
 * before any handler.
 */
export const ORG_AUTH_ERRORS = {
  401:
    'API_KEY_MISSING / API_KEY_INVALID / PUBLISHABLE_KEY_INVALID: missing or invalid ' +
    'Application credential; or USER_TOKEN_MISSING / USER_TOKEN_INVALID / ' +
    'USER_TOKEN_WRONG_APPLICATION / IMPERSONATION_SESSION_ENDED: missing, invalid, or ' +
    "mismatched end-user token (X-Rekey-User-Token).",
  403:
    'IP_NOT_ALLOWED / ORIGIN_NOT_ALLOWED: the caller is outside the presented key\'s ' +
    "allowlist; or API_KEY_SCOPE_INSUFFICIENT: a secret key was presented without the " +
    'scope the method needs (`auth:read` for GET, `auth:write` for every other method).',
} as const;
