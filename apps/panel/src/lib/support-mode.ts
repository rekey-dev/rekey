/**
 * What the end-user "Support mode" tab and the Application "Support mode" page
 * share: the catalogue read, the error copy and the labels.
 */

import type {
  SupportCapabilityDto,
  SupportCaseClosedCause,
  SupportCaseDto,
  SupportCaseNoteDto,
} from '@rekey.dev/shared-types';
import { apiGet, unlessBusy } from '@/lib/api';

export type { SupportCapabilityDto, SupportCaseDto, SupportCaseNoteDto };

const DAY_MS = 86_400_000;

/**
 * The API's capability name grammar as an HTML `pattern`. The browser compiles
 * a pattern with the `v` flag, where a bare hyphen in a character class is a
 * syntax error and the whole pattern is discarded, so the hyphen is escaped.
 */
export const CAPABILITY_NAME_PATTERN = '^[a-z0-9]+(?:[._\\-][a-z0-9]+)*$';
export const CAPABILITY_NAME_MAX = 64;
export const SUPPORT_REASON_MAX = 500;
export const SUPPORT_NOTE_MAX = 2000;

export const SUPPORT_ERR: Record<string, string> = {
  SUPPORT_CASE_ALREADY_OPEN:
    'This end-user already has an open support case. Change that one, or end it first.',
  SUPPORT_CASE_NOT_OPEN: 'No support case is open on this end-user. It may have been ended already.',
  SUPPORT_CAPABILITIES_REQUIRED: 'Pick at least one capability, and no more than 32.',
  SUPPORT_CAPABILITY_UNKNOWN:
    'One of those capabilities is no longer in the catalogue. Reload and pick again.',
  SUPPORT_REASON_INVALID: 'Write a reason of up to 500 characters. Only operators see it.',
  SUPPORT_NOTE_INVALID: 'Write a note of up to 2000 characters. Only operators see it.',
  SUPPORT_CASE_DEVICE_NOT_FOUND: 'One of those devices does not belong to this end-user. Reload and pick again.',
  SUPPORT_CASE_DEVICE_NOT_ACTIVE:
    'One of those devices was released or blocked. A case can only cover active devices. Reload and pick again.',
  SUPPORT_CASE_DEVICES_EMPTY: 'Pick at least one device, or choose All devices.',
  SUPPORT_CAPABILITY_NAME_INVALID:
    'Use lowercase letters and digits, separated by single dots, hyphens or underscores, 64 characters at most.',
  SUPPORT_CAPABILITY_NAME_TAKEN: 'A capability with that name already exists.',
  SUPPORT_CAPABILITY_NOT_FOUND: 'That capability no longer exists. It may have been deleted already.',
  SUPPORT_CAPABILITY_IN_USE:
    'An open support case uses this capability. Remove it from that case or end the case, then delete.',
  SUPPORT_CAPABILITY_LIMIT: 'The catalogue is full at 100 capabilities. Delete one you no longer use.',
  END_USER_BANNED: 'This end-user is banned. Lift the ban before opening a support case.',
  END_USER_ERASED: 'This end-user was erased. There is no account left to support.',
  END_USER_NOT_FOUND: 'That end-user no longer exists in this Application.',
  APP_ACCESS_DENIED: 'Your access to this Application is read-only.',
  SCOPE_INSUFFICIENT: 'Your access does not include changing end-users on this Application.',
  TENANT_ROLE_INSUFFICIENT: 'Your role cannot change support mode on this Application.',
};

const CLOSED_CAUSE_LABEL: Record<SupportCaseClosedCause, string> = {
  operator: 'ended by an operator',
  banned: 'end-user banned',
  erased: 'end-user erased or deleted',
  device_released: 'last device released or blocked',
};

export function closedCauseLabel(cause: SupportCaseClosedCause | null): string {
  return cause === null ? 'closed' : CLOSED_CAUSE_LABEL[cause];
}

/** The operator behind a case's `openedBy` / `closedBy`, for display. */
export function operatorName(email: string | null, id: string | null): string {
  return email ?? (id ? 'a former member' : 'unknown');
}

/** Whole days a case has been open, for the "oldest first" list. */
function caseAgeDays(openedAt: string, now: number = Date.now()): number {
  const opened = new Date(openedAt).getTime();
  if (Number.isNaN(opened)) return 0;
  return Math.max(0, Math.floor((now - opened) / DAY_MS));
}

export function caseAgeLabel(openedAt: string, now: number = Date.now()): string {
  const days = caseAgeDays(openedAt, now);
  if (days === 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

export function caseScopeLabel(c: Pick<SupportCaseDto, 'scope' | 'deviceIds'>): string {
  if (c.scope === 'USER') return 'All devices';
  return c.deviceIds.length === 1 ? '1 device' : `${c.deviceIds.length} devices`;
}

/**
 * The Application's capability catalogue. Null when it could not be read, so a
 * failed read is never shown as "no capabilities yet".
 */
export function getSupportCapabilities(applicationId: string): Promise<SupportCapabilityDto[] | null> {
  return apiGet<SupportCapabilityDto[]>(
    `/api/v1/tenant/applications/${encodeURIComponent(applicationId)}/support-capabilities`,
    { interruptOnAccessError: false },
  ).catch(unlessBusy(() => null));
}
