/**
 * What the panel reads about one list: its members, its submissions, and the
 * CSV export. Every query is scoped by `applicationId` and the list id, after
 * the route resolved access.
 */

import type { Prisma } from '@prisma/client';
import type {
  ContactListMemberRowDto,
  ContactSubmissionRowDto,
  ListMemberStatus,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { paged, type Paged } from '../../lib/pagination.js';
import { enqueueEvent, kickDeliveries } from '../webhooks/webhook.service.js';
import { listIdNotFound, memberNotFound } from './errors.js';

const EXPORT_BATCH = 1_000;

async function ownedList(applicationId: string, listId: string) {
  const list = await prisma.contactList.findFirst({ where: { id: listId, applicationId } });
  if (!list) throw listIdNotFound();
  return list;
}

type MemberWithContact = Prisma.ContactListMemberGetPayload<{ include: { contact: true } }>;

/** The end users of this Application at these addresses, joined by address rather than a stored id. */
async function endUsersByEmail(applicationId: string, emails: string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const users = await prisma.endUser.findMany({
    where: { applicationId, email: { in: emails }, erasedAt: null },
    select: { id: true, email: true },
  });
  return new Map(users.map((u) => [u.email.toLowerCase(), u.id]));
}

function memberRow(m: MemberWithContact, endUserId: string | null): ContactListMemberRowDto {
  return {
    memberId: m.id,
    contactId: m.contactId,
    email: m.contact.email,
    name: m.contact.name,
    status: m.status as ListMemberStatus,
    source: m.source,
    consentVersion: m.consentVersion,
    consentAt: m.consentAt?.toISOString() ?? null,
    consentIpPrefix: m.consentIpPrefix,
    sourceUrl: m.sourceUrl,
    subscribedAt: m.createdAt.toISOString(),
    unsubscribedAt: m.unsubscribedAt?.toISOString() ?? null,
    endUserId,
  };
}

export interface MemberFilter {
  status: ListMemberStatus | undefined;
  search: string | undefined;
  take: number;
  skip: number;
}

function memberWhere(listId: string, filter: Pick<MemberFilter, 'status' | 'search'>): Prisma.ContactListMemberWhereInput {
  return {
    listId,
    ...(filter.status && { status: filter.status }),
    ...(filter.search && {
      contact: {
        OR: [
          { email: { contains: filter.search.toLowerCase() } },
          { name: { contains: filter.search, mode: 'insensitive' } },
        ],
      },
    }),
  };
}

export async function operatorMembers(
  applicationId: string,
  listId: string,
  filter: MemberFilter,
): Promise<Paged<ContactListMemberRowDto>> {
  const list = await ownedList(applicationId, listId);
  const where = memberWhere(list.id, filter);
  const [rows, total] = await Promise.all([
    prisma.contactListMember.findMany({
      where,
      include: { contact: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.take,
      skip: filter.skip,
    }),
    prisma.contactListMember.count({ where }),
  ]);
  const users = await endUsersByEmail(applicationId, rows.map((r) => r.contact.email));
  return paged(rows.map((r) => memberRow(r, users.get(r.contact.email) ?? null)), total, filter.take, filter.skip);
}

export async function operatorSubmissions(
  applicationId: string,
  listId: string,
  page: { take: number; skip: number },
): Promise<Paged<ContactSubmissionRowDto>> {
  const list = await ownedList(applicationId, listId);
  const [rows, total] = await Promise.all([
    prisma.contactSubmission.findMany({
      where: { listId: list.id },
      include: { contact: { select: { email: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: page.take,
      skip: page.skip,
    }),
    prisma.contactSubmission.count({ where: { listId: list.id } }),
  ]);
  return paged(
    rows.map((s) => ({
      id: s.id,
      contactId: s.contactId,
      email: s.contact.email,
      fields: s.fields as ContactSubmissionRowDto['fields'],
      createdAt: s.createdAt.toISOString(),
    })),
    total,
    page.take,
    page.skip,
  );
}

/** An operator takes someone off a list. Operators can never add someone back: only the person, through your server, can. */
export async function operatorUnsubscribe(
  applicationId: string,
  listId: string,
  memberId: string,
): Promise<{ changed: boolean; member: ContactListMemberRowDto }> {
  const list = await ownedList(applicationId, listId);
  const { changed, member, deliveryIds } = await prisma.$transaction(async (tx) => {
    const existing = await tx.contactListMember.findFirst({ where: { id: memberId, listId: list.id } });
    if (!existing) throw memberNotFound();
    const now = new Date();
    const updated = await tx.contactListMember.updateMany({
      where: { id: existing.id, status: 'subscribed' },
      data: { status: 'unsubscribed', unsubscribedAt: now },
    });
    const row = await tx.contactListMember.findUniqueOrThrow({ where: { id: existing.id }, include: { contact: true } });
    if (updated.count === 0) return { changed: false, member: row, deliveryIds: [] as string[] };
    const ids = await enqueueEvent(tx, {
      applicationId,
      type: 'contact.unsubscribed',
      data: {
        contact: { id: row.contact.id, email: row.contact.email, name: row.contact.name },
        list: { id: list.id, key: list.key },
        member: { status: 'unsubscribed', unsubscribedAt: now.toISOString() },
      },
    });
    return { changed: true, member: row, deliveryIds: ids };
  });
  kickDeliveries(deliveryIds);
  const users = await endUsersByEmail(applicationId, [member.contact.email]);
  return { changed, member: memberRow(member, users.get(member.contact.email) ?? null) };
}

/** One CSV cell: quoted when needed, and a leading `= + - @` defused so a spreadsheet never runs it. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  'email',
  'name',
  'status',
  'source',
  'consentVersion',
  'consentAt',
  'consentIpPrefix',
  'sourceUrl',
  'subscribedAt',
  'unsubscribedAt',
] as const;

/** Every member of a list as CSV, read in batches. */
export async function exportMembersCsv(
  applicationId: string,
  listId: string,
): Promise<{ key: string; csv: string; count: number }> {
  const list = await ownedList(applicationId, listId);
  const lines: string[] = [CSV_COLUMNS.join(',')];
  let cursor: string | undefined;
  for (;;) {
    const batch = await prisma.contactListMember.findMany({
      where: { listId: list.id },
      include: { contact: true },
      orderBy: { id: 'asc' },
      take: EXPORT_BATCH,
      ...(cursor !== undefined && { cursor: { id: cursor }, skip: 1 }),
    });
    for (const m of batch) {
      const row = memberRow(m, null);
      lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
    }
    if (batch.length < EXPORT_BATCH) break;
    cursor = batch.at(-1)!.id;
  }
  return { key: list.key, csv: `${lines.join('\r\n')}\r\n`, count: lines.length - 1 };
}
