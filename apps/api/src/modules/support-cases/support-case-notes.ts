/**
 * Operator notes on a support case: what was tried, what the customer said.
 *
 * Append-only, and the note row is the whole record: no webhook and no
 * security event is written for one. A note is free text about a person, so
 * like the case's reason it is operator-only, and it is deleted when the
 * end-user is erased or deleted.
 */

import type { SupportCaseNoteDto } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { lockEndUser, normaliseOperatorText } from '../end-user-bans/end-user-bans.service.js';
import { lockOpenCase, notOpen } from './support-case-writes.js';

export const SUPPORT_NOTE_MAX = 2000;
/** The most notes one `GET .../end-users/:euid/support` response carries. */
export const SUPPORT_NOTES_PER_RESPONSE = 200;

interface NoteRow {
  id: string;
  caseId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

async function toDtos(rows: NoteRow[]): Promise<SupportCaseNoteDto[]> {
  const authorIds = [...new Set(rows.map((r) => r.authorId))];
  const authors =
    authorIds.length > 0
      ? await prisma.tenantUser.findMany({ where: { id: { in: authorIds } }, select: { id: true, email: true } })
      : [];
  const email = new Map(authors.map((a) => [a.id, a.email]));
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    authorId: r.authorId,
    authorEmail: email.get(r.authorId) ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Add a note to the end-user's open case. Takes the end-user row lock every
 * close by an operator takes, then the case row lock, so a note cannot land on
 * a case that is closing.
 *
 * @example
 *   const note = await addSupportCaseNote({ applicationId, endUserId, body: 'Sent build 4.2.1', authorId });
 */
export async function addSupportCaseNote(args: {
  applicationId: string;
  endUserId: string;
  body: string;
  authorId: string;
}): Promise<SupportCaseNoteDto> {
  const { applicationId, endUserId, authorId } = args;
  const body = normaliseOperatorText(args.body, {
    max: SUPPORT_NOTE_MAX,
    code: 'SUPPORT_NOTE_INVALID',
    message: `A support case note is 1 to ${SUPPORT_NOTE_MAX} characters.`,
    fix: `Send \`body\` with 1 to ${SUPPORT_NOTE_MAX} characters of text. Split a longer note into several.`,
  });
  const row = await prisma.$transaction(async (tx) => {
    await lockEndUser(tx, applicationId, endUserId);
    const open = await lockOpenCase(tx, applicationId, endUserId);
    if (!open) throw notOpen('add a note to');
    return tx.supportCaseNote.create({ data: { applicationId, caseId: open.id, endUserId, authorId, body } });
  });
  return (await toDtos([row]))[0]!;
}

/**
 * The notes of these cases by case id, oldest first within a case. One query
 * for all of them, keeping the newest `SUPPORT_NOTES_PER_RESPONSE`.
 *
 * @example
 *   const notes = (await notesFor([open.id])).get(open.id) ?? [];
 */
export async function notesFor(caseIds: readonly string[]): Promise<Map<string, SupportCaseNoteDto[]>> {
  const byCase = new Map<string, SupportCaseNoteDto[]>();
  if (caseIds.length === 0) return byCase;
  const rows = await prisma.supportCaseNote.findMany({
    where: { caseId: { in: [...caseIds] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: SUPPORT_NOTES_PER_RESPONSE,
  });
  rows.reverse();
  const dtos = await toDtos(rows);
  rows.forEach((row, i) => {
    byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), dtos[i]!]);
  });
  return byCase;
}

/**
 * @example
 *   const count = (await noteCountsFor([row.id])).get(row.id) ?? 0;
 */
export async function noteCountsFor(caseIds: readonly string[]): Promise<Map<string, number>> {
  if (caseIds.length === 0) return new Map();
  const counts = await prisma.supportCaseNote.groupBy({
    by: ['caseId'],
    where: { caseId: { in: [...caseIds] } },
    _count: { _all: true },
  });
  return new Map(counts.map((c) => [c.caseId, c._count._all]));
}
