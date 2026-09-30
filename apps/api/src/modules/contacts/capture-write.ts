/**
 * The write half of a subscribe, in one transaction: the contact, the
 * membership, the submission and their webhooks commit together or not at all.
 */

import type { ContactList, Prisma } from '@prisma/client';
import type { ListSubscribeOutcome } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import { contactQuotaExceeded } from './errors.js';
import { countContacts } from './quota.js';
import { tombstoned } from './erasure-tombstone.js';

type Tx = Prisma.TransactionClient;

export interface CaptureWrite {
  tenantId: string;
  list: ContactList;
  email: string;
  name: string | undefined;
  fields: Record<string, string | number | boolean>;
  /**
   * The Application's own server speaking for itself: a secret key that names
   * no visitor. Only it may overwrite a name, re-subscribe with consent, or
   * add an address with a notification-only suppression. A secret key that
   * relays a browser (it sends `X-Rekey-Client-Ip`) is not authoritative:
   * whatever the page posted is still a stranger's input.
   */
  authoritative: boolean;
  source: 'publishable' | 'secret';
  consent: { version: number } | undefined;
  consentIpPrefix: string | null;
  sourceUrl: string | null;
  maxContacts: number | null | undefined;
}

/**
 * Any suppression blocks input from a browser, a one-click notification
 * opt-out included, and so does a recent erasure of the address. The Application's own server may still add an address
 * whose only suppression is that opt-out, since it covers notification mail.
 */
async function suppressed(tx: Tx, w: CaptureWrite): Promise<boolean> {
  const row = await tx.emailSuppression.findUnique({
    where: { applicationId_address: { applicationId: w.list.applicationId, address: w.email } },
    select: { category: true },
  });
  if (row !== null) return !w.authoritative || row.category === null;
  return !w.authoritative && (await tombstoned(tx, w.list.applicationId, w.email));
}

/**
 * Only a subscribe that would store a NEW contact is counted, so a workspace
 * at its ceiling still lets existing contacts join and leave lists.
 */
async function findOrCreateContact(tx: Tx, w: CaptureWrite): Promise<{ id: string; email: string; name: string | null }> {
  const applicationId = w.list.applicationId;
  const existing = await tx.contact.findUnique({ where: { applicationId_email: { applicationId, email: w.email } } });
  if (existing) {
    const rename = w.name !== undefined && (w.authoritative || existing.name === null) && existing.name !== w.name;
    return rename ? tx.contact.update({ where: { id: existing.id }, data: { name: w.name! } }) : existing;
  }
  if (w.maxContacts !== null && w.maxContacts !== undefined) {
    // Held to the end of the transaction, so concurrent new contacts are
    // counted one after another and the ceiling holds exactly. Only the
    // insert path takes it; an existing contact never waits here.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`contacts:${w.tenantId}`}))`;
    const current = await countContacts(w.tenantId, tx);
    if (current >= w.maxContacts) throw contactQuotaExceeded(w.maxContacts, current);
  }
  // Not `upsert`: two first subscribes of one address race here, and a
  // unique violation would abort the whole transaction.
  await tx.contact.createMany({
    data: [{ applicationId, email: w.email, name: w.name ?? null }],
    skipDuplicates: true,
  });
  return tx.contact.findUniqueOrThrow({ where: { applicationId_email: { applicationId, email: w.email } } });
}

function consentProof(w: CaptureWrite, now: Date) {
  return w.consent
    ? { consentVersion: w.consent.version, consentAt: now, consentIpPrefix: w.consentIpPrefix }
    : { consentVersion: null, consentAt: null, consentIpPrefix: null };
}

type MemberResult = { status: ListSubscribeOutcome['status']; member: Prisma.ContactListMemberGetPayload<object> | null };

async function upsertMembership(tx: Tx, w: CaptureWrite, contactId: string, now: Date): Promise<MemberResult> {
  const source = w.source;
  const created = await tx.contactListMember.createMany({
    data: [
      {
        applicationId: w.list.applicationId,
        listId: w.list.id,
        contactId,
        status: 'subscribed',
        source,
        sourceUrl: w.sourceUrl,
        ...consentProof(w, now),
      },
    ],
    skipDuplicates: true,
  });
  const member = await tx.contactListMember.findUniqueOrThrow({
    where: { listId_contactId: { listId: w.list.id, contactId } },
  });
  if (created.count === 1) return { status: 'subscribed', member };
  if (member.status === 'subscribed') return { status: 'already_subscribed', member: null };
  // A browser can never add back someone who left: anyone can type anyone's
  // address into a public form. Only the Application's own server, stating
  // consent, can.
  if (!w.authoritative || !w.consent) return { status: 'previously_unsubscribed', member: null };
  const resubscribed = await tx.contactListMember.update({
    where: { id: member.id },
    data: { status: 'subscribed', source, unsubscribedAt: null, sourceUrl: w.sourceUrl, ...consentProof(w, now) },
  });
  return { status: 'subscribed', member: resubscribed };
}

export async function writeSubscribe(w: CaptureWrite): Promise<ListSubscribeOutcome> {
  const applicationId = w.list.applicationId;
  const listRef = { id: w.list.id, key: w.list.key };
  const { outcome, deliveryIds } = await prisma.$transaction(async (tx) => {
    if (await suppressed(tx, w)) {
      const existing = await tx.contact.findUnique({
        where: { applicationId_email: { applicationId, email: w.email } },
        select: { id: true },
      });
      return { outcome: { status: 'suppressed' as const, contactId: existing?.id ?? null }, deliveryIds: [] };
    }
    const now = new Date();
    const contact = await findOrCreateContact(tx, w);
    const { status, member } = await upsertMembership(tx, w, contact.id, now);
    const ids: string[] = [];
    if (member) {
      ids.push(
        ...(await enqueueEvent(tx, {
          applicationId,
          type: 'contact.subscribed',
          data: {
            contact: { id: contact.id, email: contact.email, name: contact.name },
            list: listRef,
            member: {
              status: member.status,
              source: member.source,
              consentVersion: member.consentVersion,
              consentAt: member.consentAt?.toISOString() ?? null,
            },
          },
        })),
      );
    }
    if (Object.keys(w.fields).length > 0) {
      const submission = await tx.contactSubmission.create({
        data: { applicationId, listId: w.list.id, contactId: contact.id, fields: w.fields },
      });
      ids.push(
        ...(await enqueueEvent(tx, {
          applicationId,
          type: 'contact.submission.created',
          data: {
            contact: { id: contact.id, email: contact.email },
            list: listRef,
            submission: { id: submission.id, fields: w.fields, createdAt: submission.createdAt.toISOString() },
          },
        })),
      );
    }
    return { outcome: { status, contactId: contact.id }, deliveryIds: ids };
  });
  kickDeliveries(deliveryIds);
  return outcome;
}
