/**
 * List management for operators. Every read and write is scoped by
 * `applicationId`; the routes resolve it through `ensureAppAccess` first.
 */

import { Prisma, type ContactList } from '@prisma/client';
import {
  ContactFieldSchemaSchema,
  type ContactFieldDef,
  type ContactLawfulBasis,
  type ContactListConsentVersionDto,
  type ContactListCounts,
  type ContactListDto,
  type ContactListKind,
} from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { captureUnprotected, listIdNotFound, listKeyTaken } from './errors.js';
import { assertContactListQuota } from './quota.js';

export interface ListSettings {
  name: string;
  description: string | null;
  kind: ContactListKind;
  fieldSchema: ContactFieldDef[];
  lawfulBasis: ContactLawfulBasis;
  consentText: string;
  blockDisposable: boolean;
  submissionRetentionDays: number | null;
}

type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export type CreateListInput = Patch<ListSettings> & Pick<ListSettings, 'name'> & { key: string };
export type UpdateListInput = Patch<ListSettings & { publicCapture: boolean }>;

const EMPTY_COUNTS: ContactListCounts = { subscribed: 0, unsubscribed: 0, submissions: 0 };

export function parseFieldSchema(value: Prisma.JsonValue): ContactFieldDef[] {
  const parsed = ContactFieldSchemaSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function toListDto(list: ContactList, counts: ContactListCounts = EMPTY_COUNTS): ContactListDto {
  return {
    id: list.id,
    applicationId: list.applicationId,
    key: list.key,
    name: list.name,
    description: list.description,
    kind: list.kind as ContactListKind,
    fieldSchema: parseFieldSchema(list.fieldSchema),
    lawfulBasis: list.lawfulBasis as ContactLawfulBasis,
    consentText: list.consentText,
    consentVersion: list.consentVersion,
    publicCapture: list.publicCapture,
    blockDisposable: list.blockDisposable,
    submissionRetentionDays: list.submissionRetentionDays,
    archivedAt: list.archivedAt?.toISOString() ?? null,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
    counts,
  };
}

async function countsFor(applicationId: string, listIds: string[]): Promise<Map<string, ContactListCounts>> {
  const out = new Map<string, ContactListCounts>(listIds.map((id) => [id, { ...EMPTY_COUNTS }]));
  if (listIds.length === 0) return out;
  const [members, submissions] = await Promise.all([
    prisma.contactListMember.groupBy({
      by: ['listId', 'status'],
      where: { applicationId, listId: { in: listIds } },
      _count: { _all: true },
    }),
    prisma.contactSubmission.groupBy({
      by: ['listId'],
      where: { applicationId, listId: { in: listIds } },
      _count: { _all: true },
    }),
  ]);
  for (const row of members) {
    const counts = out.get(row.listId);
    if (counts && (row.status === 'subscribed' || row.status === 'unsubscribed')) {
      counts[row.status] = row._count._all;
    }
  }
  for (const row of submissions) {
    const counts = out.get(row.listId);
    if (counts) counts.submissions = row._count._all;
  }
  return out;
}

async function findOwned(applicationId: string, listId: string): Promise<ContactList> {
  const list = await prisma.contactList.findFirst({ where: { id: listId, applicationId } });
  if (!list) throw listIdNotFound();
  return list;
}

function definedOnly<T extends object>(input: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** Field names that changed, for the audit trail. Never the values. */
function changedFields(before: ContactList, patch: UpdateListInput): string[] {
  return (Object.keys(patch) as Array<keyof UpdateListInput>).filter((field) => {
    const next = patch[field];
    if (next === undefined) return false;
    const current = field === 'fieldSchema' ? parseFieldSchema(before.fieldSchema) : before[field];
    return JSON.stringify(current) !== JSON.stringify(next);
  });
}

export const listsService = {
  async list(applicationId: string): Promise<ContactListDto[]> {
    const lists = await prisma.contactList.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    const counts = await countsFor(applicationId, lists.map((l) => l.id));
    return lists.map((l) => toListDto(l, counts.get(l.id)));
  },

  async get(
    applicationId: string,
    listId: string,
  ): Promise<ContactListDto & { consentVersions: ContactListConsentVersionDto[] }> {
    const list = await findOwned(applicationId, listId);
    const [counts, versions] = await Promise.all([
      countsFor(applicationId, [list.id]),
      prisma.contactListConsentVersion.findMany({
        where: { listId: list.id },
        orderBy: { version: 'desc' },
        take: 100,
      }),
    ]);
    return {
      ...toListDto(list, counts.get(list.id)),
      consentVersions: versions.map((v) => ({
        version: v.version,
        text: v.text,
        createdBy: v.createdBy,
        createdAt: v.createdAt.toISOString(),
      })),
    };
  },

  async create(
    tenantId: string,
    applicationId: string,
    operatorId: string,
    input: CreateListInput,
  ): Promise<ContactListDto> {
    try {
      const list = await prisma.$transaction(async (tx) => {
        await assertContactListQuota(tenantId, tx);
        const { key, name, fieldSchema, consentText, ...rest } = input;
        const created = await tx.contactList.create({
          data: {
            ...definedOnly(rest),
            key,
            name,
            applicationId,
            ...(fieldSchema !== undefined && { fieldSchema: fieldSchema as Prisma.InputJsonValue }),
            ...(consentText !== undefined && { consentText, consentVersion: 1 }),
          },
        });
        if (consentText !== undefined) {
          await tx.contactListConsentVersion.create({
            data: { applicationId, listId: created.id, version: 1, text: consentText, createdBy: operatorId },
          });
        }
        return created;
      });
      return toListDto(list);
    } catch (err) {
      if (isUniqueViolation(err)) throw listKeyTaken(input.key);
      throw err;
    }
  },

  /**
   * Apply a settings patch. A new consent text gets the next version number
   * and a history row in the same transaction, so a version always names the
   * text a person was shown.
   */
  async update(
    applicationId: string,
    listId: string,
    operatorId: string,
    patch: UpdateListInput,
  ): Promise<{ list: ContactListDto; changed: string[] }> {
    const before = await findOwned(applicationId, listId);
    if (patch.publicCapture === true && !before.publicCapture) {
      const app = await prisma.application.findUniqueOrThrow({
        where: { id: applicationId },
        select: { corsOrigins: true },
      });
      if (app.corsOrigins.length === 0) throw captureUnprotected();
    }
    const changed = changedFields(before, patch);
    if (changed.length === 0) return { list: (await this.get(applicationId, listId)), changed };

    const { fieldSchema, consentText, ...rest } = patch;
    await prisma.$transaction(async (tx) => {
      let consent: { consentText: string; consentVersion: number } | undefined;
      if (consentText !== undefined && changed.includes('consentText')) {
        const bumped = await tx.contactList.update({
          where: { id: before.id },
          data: { consentVersion: { increment: 1 } },
          select: { consentVersion: true },
        });
        await tx.contactListConsentVersion.create({
          data: {
            applicationId,
            listId: before.id,
            version: bumped.consentVersion,
            text: consentText,
            createdBy: operatorId,
          },
        });
        consent = { consentText, consentVersion: bumped.consentVersion };
      }
      await tx.contactList.update({
        where: { id: before.id },
        data: {
          ...definedOnly(rest),
          ...(fieldSchema !== undefined && { fieldSchema: fieldSchema as Prisma.InputJsonValue }),
          ...consent,
        },
      });
    });
    return { list: await this.get(applicationId, listId), changed };
  },

  async archive(applicationId: string, listId: string): Promise<{ list: ContactListDto; changed: boolean }> {
    const before = await findOwned(applicationId, listId);
    if (before.archivedAt) return { list: await this.get(applicationId, listId), changed: false };
    await prisma.contactList.update({ where: { id: before.id }, data: { archivedAt: new Date() } });
    return { list: await this.get(applicationId, listId), changed: true };
  },

  async restore(
    tenantId: string,
    applicationId: string,
    listId: string,
  ): Promise<{ list: ContactListDto; changed: boolean }> {
    const before = await findOwned(applicationId, listId);
    if (!before.archivedAt) return { list: await this.get(applicationId, listId), changed: false };
    await prisma.$transaction(async (tx) => {
      await assertContactListQuota(tenantId, tx);
      await tx.contactList.update({ where: { id: before.id }, data: { archivedAt: null } });
    });
    return { list: await this.get(applicationId, listId), changed: true };
  },
};
