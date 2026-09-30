/**
 * Server-side membership reads and changes that do not come from a
 * subscribe: reading a list out, and taking someone off it. Rekey sends no
 * list mail in v1, so the customer's own email tool reads members from here
 * and syncs its unsubscribes back.
 */

import type { ContactList } from '@prisma/client';
import type { ListMemberStatus, ListMembersPage } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import { cursorInvalid, listNotFound } from './errors.js';

export interface UnsubscribeResult {
  /** `unsubscribed`: this call took them off. `not_subscribed`: they were not on it. */
  status: 'unsubscribed' | 'not_subscribed';
}

/** A list by key for a server, archived included: leaving must work on a list that no longer takes subscribes. */
export async function findListForServer(applicationId: string, key: string): Promise<ContactList> {
  const list = await prisma.contactList.findUnique({ where: { applicationId_key: { applicationId, key } } });
  if (list) return list;
  const all = await prisma.contactList.findMany({
    where: { applicationId },
    select: { key: true },
    orderBy: { key: 'asc' },
    take: 50,
  });
  throw listNotFound(key, all.map((l) => l.key));
}

export interface MembersQuery {
  status: ListMemberStatus | 'all';
  updatedSince?: Date | undefined;
  cursor?: string | undefined;
  limit: number;
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } {
  const [iso = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const updatedAt = new Date(iso);
  if (!id || Number.isNaN(updatedAt.getTime())) throw cursorInvalid();
  return { updatedAt, id };
}

/**
 * Members oldest change first, keyset-paginated on (updatedAt, id), so a
 * sync that stores the last `updatedAt` it saw and passes it back as
 * `updatedSince` picks up every later change, including unsubscribes.
 */
export async function listMembers(applicationId: string, key: string, query: MembersQuery): Promise<ListMembersPage> {
  const list = await findListForServer(applicationId, key);
  const after = query.cursor ? decodeCursor(query.cursor) : undefined;
  const rows = await prisma.contactListMember.findMany({
    where: {
      listId: list.id,
      ...(query.status !== 'all' && { status: query.status }),
      AND: [
        ...(query.updatedSince ? [{ updatedAt: { gt: query.updatedSince } }] : []),
        ...(after
          ? [{ OR: [{ updatedAt: { gt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { gt: after.id } }] }]
          : []),
      ],
    },
    include: { contact: { select: { email: true, name: true } } },
    orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((m) => ({
      contactId: m.contactId,
      email: m.contact.email,
      name: m.contact.name,
      status: m.status as ListMemberStatus,
      source: m.source,
      consentVersion: m.consentVersion,
      consentAt: m.consentAt?.toISOString() ?? null,
      subscribedAt: m.createdAt.toISOString(),
      unsubscribedAt: m.unsubscribedAt?.toISOString() ?? null,
      updatedAt: m.updatedAt.toISOString(),
    })),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.updatedAt, last.id) : null,
  };
}

/** Take one address off one list. Idempotent; `contact.unsubscribed` fires only on the change. */
export async function unsubscribe(applicationId: string, key: string, rawEmail: string): Promise<UnsubscribeResult> {
  const list = await findListForServer(applicationId, key);
  const email = rawEmail.trim().toLowerCase();
  const { changed, deliveryIds } = await prisma.$transaction(async (tx) => {
    const contact = await tx.contact.findUnique({ where: { applicationId_email: { applicationId, email } } });
    if (!contact) return { changed: false, deliveryIds: [] };
    const now = new Date();
    const updated = await tx.contactListMember.updateMany({
      where: { listId: list.id, contactId: contact.id, status: 'subscribed' },
      data: { status: 'unsubscribed', unsubscribedAt: now },
    });
    if (updated.count === 0) return { changed: false, deliveryIds: [] };
    const ids = await enqueueEvent(tx, {
      applicationId,
      type: 'contact.unsubscribed',
      data: {
        contact: { id: contact.id, email: contact.email, name: contact.name },
        list: { id: list.id, key: list.key },
        member: { status: 'unsubscribed', unsubscribedAt: now.toISOString() },
      },
    });
    return { changed: true, deliveryIds: ids };
  });
  kickDeliveries(deliveryIds);
  return { status: changed ? 'unsubscribed' : 'not_subscribed' };
}
