/**
 * The refusals of the custom template routes, in one place so the send route,
 * the operator routes and docs/errors.md say the same thing.
 */

import { RekeyError } from '../../../lib/error.js';
import type { VariableIssue } from './variables.js';

const TEMPLATES_PAGE = 'Panel → Application → Email → Custom templates';
const SETTINGS_PAGE = 'Panel → Application → Email → Settings';

export function templateNotFound(key: string): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'EMAIL_TEMPLATE_NOT_FOUND',
    message: `No custom email template "${key}" in this application.`,
    fix: `Check the key against ${TEMPLATES_PAGE}. Keys are lowercase and exact.`,
  });
}

export function versionNotFound(key: string, version: number, latest: number): RekeyError {
  return new RekeyError({
    statusCode: 404,
    code: 'EMAIL_TEMPLATE_NOT_FOUND',
    message: `Template "${key}" has no published version ${version}. The latest is ${latest}.`,
    fix: `Omit \`version\` to send the latest published version, or pass a version from 1 to ${latest}.`,
  });
}

export function templateNotPublished(key: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_TEMPLATE_NOT_PUBLISHED',
    message: `Template "${key}" is a draft and has never been published.`,
    fix: `Publish it in ${TEMPLATES_PAGE}, then send again.`,
  });
}

export function transportNotCustom(via: string): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'EMAIL_TRANSPORT_NOT_CUSTOM',
    message:
      via === 'default_resend'
        ? 'This application sends email through the shared pool, which custom templates never use.'
        : 'This application has no email provider of its own configured.',
    fix: `Connect your own Resend API key or SMTP server in ${SETTINGS_PAGE}. Custom templates only send through the application's own provider.`,
  });
}

export function noFromAddress(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_SENDER_DOMAIN_MISMATCH',
    message: 'This application has no From address configured.',
    fix: `Set the From address in ${SETTINGS_PAGE}.`,
  });
}

export function senderDomainMismatch(
  key: string,
  version: number,
  publishedFor: string,
  current: string,
): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_SENDER_DOMAIN_MISMATCH',
    message: `Template "${key}" version ${version} was published for ${publishedFor}, but this application now sends from ${current}.`,
    fix: `Check the template still suits ${current}, then publish it again in ${TEMPLATES_PAGE}.`,
  });
}

export function variablesInvalid(key: string, version: number, issues: VariableIssue[]): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'EMAIL_VARIABLES_INVALID',
    message: `${issues.length} variable problem${issues.length === 1 ? '' : 's'} against template "${key}" version ${version}.`,
    fix: `Correct each entry in \`details.issues\`. The template's declared variables are listed in ${TEMPLATES_PAGE}.`,
    details: { issues },
  });
}

export function templateInvalid(issues: VariableIssue[]): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'EMAIL_TEMPLATE_INVALID',
    message: `The template cannot be published: ${issues.length} problem${issues.length === 1 ? '' : 's'} found.`,
    fix: 'Correct each entry in `details.issues` in the draft, then publish again.',
    details: { issues },
  });
}

export function recipientNotEndUser(): RekeyError {
  return new RekeyError({
    statusCode: 403,
    code: 'EMAIL_RECIPIENT_NOT_END_USER',
    message: 'This application only sends custom email to its own end users, and that address is not one.',
    fix: `Send to the address of an existing end user, or turn off "Only send to end users" in ${TEMPLATES_PAGE}.`,
  });
}

export function templateKeyTaken(key: string): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_TEMPLATE_KEY_TAKEN',
    message: `This application already has a custom template "${key}".`,
    fix: 'Pick another key, or edit the existing template.',
  });
}

export function templateLimitReached(limit: number): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_TEMPLATE_LIMIT_REACHED',
    message: `This application already has ${limit} custom templates, the most it can hold.`,
    fix: 'Delete a template you no longer send before creating another.',
  });
}

export function idempotencyKeyReused(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_IDEMPOTENCY_KEY_REUSED',
    message: 'This idempotency key was already used for a different send (template, recipient, version or variables differ).',
    fix: 'Use a new idempotency key for a different email. Reuse a key only to retry exactly the same send.',
  });
}

export function sendInFlight(): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_SEND_IN_FLIGHT',
    message: 'A send with this idempotency key has started and has not finished.',
    fix: 'Retry with the same key after Retry-After. If this persists for more than a minute the first attempt was interrupted and its outcome is unknown: check Panel → Application → Email → Logs before sending again with a new key.',
    retryAfterSeconds: 1,
  });
}

export function sendOutcomeUnknown(logId: string, keyed: boolean): RekeyError {
  return new RekeyError({
    statusCode: 409,
    code: 'EMAIL_SEND_OUTCOME_UNKNOWN',
    message:
      'The first send with this idempotency key started more than five minutes ago and never recorded an outcome, so it is not known whether the provider accepted it.',
    fix: keyed
      ? "Check the recipient's inbox or your provider's log for this message. If it was not delivered, send again with a new idempotency key; this key stays bound to the unknown attempt."
      : "Check your provider's log for this message before sending again.",
    details: { id: logId },
  });
}

export function deliveryFailed(reason: string, logId: string, keyed: boolean): RekeyError {
  const check = `Check the provider credentials and the From address in ${SETTINGS_PAGE}.`;
  return new RekeyError({
    statusCode: 502,
    code: 'EMAIL_DELIVERY_FAILED',
    message: `The application's email provider did not accept the message: ${reason}`,
    fix: keyed
      ? `${check} This idempotency key stays bound to this failed attempt, so retry with a new key.`
      : `${check} Then send again.`,
    details: { id: logId },
  });
}
