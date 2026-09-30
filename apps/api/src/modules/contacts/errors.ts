import { RekeyError } from '../../lib/error.js';

/** The workspace ceilings are written by the deployment, never by an operator. */
export const RAISE_CONTACT_LIMIT =
  'On a self-hosted deployment, a super-admin raises it with PUT /api/v1/admin/tenants/:id/limits. ' +
  "On Rekey Cloud it comes from the workspace's plan: https://rekey.dev/pricing lists what each plan includes.";

export function listNotFound(key: string, available?: readonly string[]): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'LIST_NOT_FOUND',
    message: `No list "${key}" in this Application.`,
    fix:
      available && available.length > 0
        ? `Use one of the keys in details.available, or create the list in Panel, Lists (POST /api/v1/tenant/applications/:id/lists).`
        : 'Create the list in Panel, Lists, or with POST /api/v1/tenant/applications/:id/lists, then use its key.',
    ...(available ? { details: { available: [...available] } } : {}),
  });
}

export function listIdNotFound(): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'LIST_NOT_FOUND',
    message: 'No list with that id in this Application.',
    fix: 'List the ids with GET /api/v1/tenant/applications/:id/lists.',
  });
}

export function listKeyTaken(key: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'LIST_KEY_TAKEN',
    message: `This Application already has a list with the key "${key}", archived or not.`,
    fix: 'Choose another key, or restore the archived list with DELETE /api/v1/tenant/applications/:id/lists/:listId/archive.',
  });
}

/** The publishable-key answer for a list that does not exist, is archived, or is not open to browsers. */
export function listNotOpen(key: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'LIST_NOT_FOUND',
    message: `No list "${key}" open to browsers in this Application.`,
    fix:
      'Check the key, then turn on Public capture for the list in Panel, Lists, Settings. ' +
      'Public capture needs at least one browser origin in Panel, Access. Or subscribe from your ' +
      'server with a secret key holding contacts:write.',
  });
}

export function captureUnprotected(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'LIST_CAPTURE_UNPROTECTED',
    message: 'Public capture needs at least one browser origin on this Application.',
    fix:
      'Add the site that hosts the form in Panel, Access (corsOrigins), then turn Public capture on. ' +
      'An origin stops other websites from using your publishable key; it does not stop scripts, ' +
      'which the rate limits and daily cap hold instead.',
  });
}

export function consentRequired(version: number): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'CONTACT_CONSENT_REQUIRED',
    message: "This list's lawful basis is consent, and the request did not say the person agreed.",
    fix: `Show the list's consent text, then send consent: { granted: true, version: ${version} } (the version GET /api/v1/lists/:key returns).`,
    details: { currentVersion: version },
  });
}

export function consentStale(sent: number, current: number): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'CONTACT_CONSENT_STALE',
    message: `The consent text changed: the request agreed to version ${sent}, the list is on version ${current}.`,
    fix: `Re-fetch GET /api/v1/lists/:key, show the current consent text, and send consent.version ${current}.`,
    details: { currentVersion: current },
  });
}

export function fieldsInvalid(issues: Array<{ path: string; message: string }>): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'CONTACT_FIELDS_INVALID',
    message: `The subscribe carried ${issues.length} invalid field${issues.length === 1 ? '' : 's'}.`,
    fix: "Fix each entry in details.issues. The list's fieldSchema (GET /api/v1/lists/:key) names every field it accepts and its rules.",
    details: { issues },
  });
}

export function emailDomainNotAllowed(): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'CONTACT_EMAIL_DOMAIN_NOT_ALLOWED',
    message: 'This list does not accept addresses at disposable email domains.',
    fix: 'Use a permanent address. An operator can allow disposable domains with the list setting blockDisposable: false.',
  });
}

export function contactQuotaExceeded(max: number, current: number): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'CONTACT_QUOTA_EXCEEDED',
    message:
      `This workspace has reached its limit of ${max} contact${max === 1 ? '' : 's'} ` +
      `(currently ${current}, counted across every application). People already on a list are unaffected.`,
    fix: `Erase contacts the workspace no longer needs, or raise the limit. ${RAISE_CONTACT_LIMIT}`,
  });
}

export function contactsRateLimited(message: string, retryAfterSeconds: number): RekeyError {
  return new RekeyError({
    statusCode: 429,
    code: 'CONTACTS_RATE_LIMITED',
    message,
    fix: 'Wait for the number of seconds in Retry-After (also error.retryAfterSeconds), then try again. Nothing was stored.',
    retryAfterSeconds,
  });
}

export function memberNotFound(): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'LIST_MEMBER_NOT_FOUND',
    message: 'No member with that id on this list.',
    fix: 'Take the memberId from GET /api/v1/tenant/applications/:id/lists/:listId/members.',
  });
}

export function cursorInvalid(): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'CONTACT_CURSOR_INVALID',
    message: 'The cursor is not one this API returned.',
    fix: 'Pass back nextCursor from the previous page unchanged, or omit cursor to start from the beginning.',
  });
}

export function listQuotaExceeded(max: number, current: number): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'CONTACT_LIST_QUOTA_EXCEEDED',
    message:
      `This workspace has reached its limit of ${max} list${max === 1 ? '' : 's'} ` +
      `(currently ${current}, counted across every application; archived lists do not count).`,
    fix: `Archive a list the workspace no longer uses, or raise the limit. ${RAISE_CONTACT_LIMIT}`,
  });
}
