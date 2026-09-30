/**
 * `GET /api/v1/lists/:key` and `POST /api/v1/lists/:key/subscribe`, for both
 * key types. A publishable key reaches only lists with public capture on, on
 * an Application with browser origins, and learns nothing about who is on a
 * list: the route answers it with a constant body whatever happened.
 */

import type { Application, ContactList } from '@prisma/client';
import type { ContactListPublicDto, ListSubscribeOutcome, ListSubscribeRequest } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { isDisposableDomain } from '../../lib/disposable-domains.js';
import { parseTenantLimits } from '../../lib/tenant-limits.js';
import { recordSecurityEvent } from '../../lib/security-events.js';
import { consumeCaptureAllowance, consumeServerAllowance, markQuotaEventDue } from './capture-limits.js';
import { writeSubscribe } from './capture-write.js';
import { consentRequired, consentStale, emailDomainNotAllowed, listNotFound, listNotOpen } from './errors.js';
import { ipPrefixOf, sourceUrlOf, validateFields } from './fields.js';
import { parseFieldSchema } from './lists.service.js';

export interface CaptureCaller {
  application: Application;
  /** A secret key: the Application's own server, possibly relaying a browser. */
  trusted: boolean;
  /** The caller said it relays a browser form (`X-Rekey-Relay: browser`). */
  relayed?: boolean;
  /** The visitor's address when one can be attributed, see `attributedAuthClientIp`. */
  visitorIp: string | null;
}

/**
 * The Application's own server speaking for itself. A secret key that names a
 * visitor, or says it relays a browser, is passing on a stranger's input, so
 * it gets the browser rules and the browser answer. The marker is what keeps
 * a relay whose visitor address went missing from becoming authoritative.
 */
export function isAuthoritative(caller: CaptureCaller): boolean {
  return caller.trusted && caller.visitorIp === null && caller.relayed !== true;
}

/** Browsers may only reach a list the operator opened, on an Application that names its sites. */
export function openToBrowsers(list: ContactList, application: Application): boolean {
  return list.publicCapture && application.corsOrigins.length > 0;
}

async function resolveList(caller: CaptureCaller, key: string): Promise<ContactList> {
  const list = await prisma.contactList.findUnique({
    where: { applicationId_key: { applicationId: caller.application.id, key } },
  });
  const usable = list !== null && list.archivedAt === null;
  if (caller.trusted) {
    if (usable) return list;
    const live = await prisma.contactList.findMany({
      where: { applicationId: caller.application.id, archivedAt: null },
      select: { key: true },
      orderBy: { key: 'asc' },
      take: 50,
    });
    throw listNotFound(key, live.map((l) => l.key));
  }
  if (!usable || !openToBrowsers(list, caller.application)) throw listNotOpen(key);
  return list;
}

export async function getPublicList(caller: CaptureCaller, key: string): Promise<ContactListPublicDto> {
  const list = await resolveList(caller, key);
  return {
    key: list.key,
    name: list.name,
    kind: list.kind as ContactListPublicDto['kind'],
    fieldSchema: parseFieldSchema(list.fieldSchema),
    consent: {
      text: list.consentText,
      version: list.consentVersion,
      lawfulBasis: list.lawfulBasis as ContactListPublicDto['consent']['lawfulBasis'],
    },
  };
}

function checkConsent(list: ContactList, consent: ListSubscribeRequest['consent']): { version: number } | undefined {
  if (!consent) {
    if (list.lawfulBasis === 'consent') throw consentRequired(list.consentVersion);
    return undefined;
  }
  if (consent.version !== list.consentVersion) throw consentStale(consent.version, list.consentVersion);
  return { version: consent.version };
}

/**
 * Run a subscribe. Order matters: the list, then the rate limits (so a flood
 * is refused before any other work), then the cheap checks, and only then the
 * write, where the contact quota is counted if and only if a new contact would
 * be stored.
 */
export async function subscribe(
  caller: CaptureCaller,
  key: string,
  body: ListSubscribeRequest,
): Promise<ListSubscribeOutcome> {
  const list = await resolveList(caller, key);
  const tenant = await prisma.tenant.findUnique({
    where: { id: caller.application.tenantId },
    select: { limits: true },
  });
  const limits = parseTenantLimits(tenant?.limits);
  if (isAuthoritative(caller)) {
    await consumeServerAllowance(list.id);
  } else {
    await consumeCaptureAllowance({
      tenantId: caller.application.tenantId,
      applicationId: caller.application.id,
      listId: list.id,
      visitorIp: caller.visitorIp,
      dailyCap: limits.contactCaptureDailyCap,
    });
  }
  if (body.hp !== undefined && body.hp.trim() !== '') return { status: 'ignored', contactId: null };

  const email = body.email.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (list.blockDisposable && isDisposableDomain(domain)) throw emailDomainNotAllowed();
  const consent = checkConsent(list, body.consent);
  const fields = validateFields(parseFieldSchema(list.fieldSchema), body.fields);

  return writeSubscribe({
    tenantId: caller.application.tenantId,
    list,
    email,
    name: body.name,
    fields,
    authoritative: isAuthoritative(caller),
    source: caller.trusted ? 'secret' : 'publishable',
    consent,
    consentIpPrefix: ipPrefixOf(caller.visitorIp),
    sourceUrl: sourceUrlOf(body.sourceUrl),
    maxContacts: limits.maxContacts,
  });
}

/**
 * A browser over the contact quota still gets the constant answer, or the
 * refusal would tell it the address is new. The operator hears about it
 * instead, at most once an hour per workspace.
 */
export async function noteQuotaRefusal(application: Application, listKey: string): Promise<void> {
  if (!(await markQuotaEventDue(application.tenantId))) return;
  await recordSecurityEvent({
    type: 'app.contact_quota_reached',
    actorType: 'system',
    tenantId: application.tenantId,
    applicationId: application.id,
    metadata: { listKey },
  });
}
