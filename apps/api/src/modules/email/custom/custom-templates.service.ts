/**
 * Custom templates: the draft row, publishing it into an immutable version,
 * and the preview. Sending lives in custom-send.service.ts.
 */

import { Prisma, type Application, type CustomEmailTemplate } from '@prisma/client';
import type {
  CustomEmailCategory,
  CustomEmailTemplateDto,
  CustomEmailVariableDef,
} from '@rekey.dev/shared-types';
import { prisma } from '../../../lib/prisma.js';
import { describeTransport } from '../../../lib/email-transport.js';
import {
  noFromAddress,
  templateInvalid,
  templateKeyTaken,
  templateLimitReached,
  templateNotFound,
  transportNotCustom,
} from './errors.js';
import { publishIssues, undeclaredNames } from './template-rules.js';
import { readVariableSchema, sampleValues } from './variables.js';
import { renderCustom } from './render-custom.js';
import { capsForTenant, type SendCaps } from './send-caps.js';

export const MAX_TEMPLATES_PER_APPLICATION = 200;

export interface CustomEmailSettings {
  eligible: boolean;
  transport: string;
  fromAddress: string | null;
  recipientsMustBeEndUsers: boolean;
  caps: SendCaps;
}

export interface DraftFields {
  name: string;
  category: CustomEmailCategory;
  fromName: string | null;
  subject: string;
  designJson: unknown;
  bodyHtml: string;
  bodyText: string | null;
  variableSchema: CustomEmailVariableDef[];
  linkDomains: string[];
}

export interface CustomTransport {
  eligible: boolean;
  via: string;
  fromAddress: string | null;
}

/** Whether this Application may publish and send custom templates, and from where. */
export function customTransport(application: Application): CustomTransport {
  const { via } = describeTransport(application);
  const fromAddress = (application.emailConfig as { fromAddress?: string } | null)?.fromAddress ?? null;
  return { eligible: via === 'byo_resend' || via === 'byo_smtp', via, fromAddress };
}

export function domainOf(address: string): string {
  return (address.split('@').pop() ?? '').toLowerCase();
}

export function toDto(row: CustomEmailTemplate): CustomEmailTemplateDto {
  return {
    id: row.id,
    applicationId: row.applicationId,
    key: row.key,
    name: row.name,
    category: row.category as CustomEmailCategory,
    fromName: row.fromName,
    subject: row.subject,
    designJson: row.designJson ?? null,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    variableSchema: readVariableSchema(row.variableSchema),
    linkDomains: row.linkDomains,
    status: row.status === 'published' ? 'published' : 'draft',
    version: row.version,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    hasUnpublishedChanges: row.publishedAt !== null && row.updatedAt > row.publishedAt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}

async function findOrThrow(applicationId: string, key: string): Promise<CustomEmailTemplate> {
  const row = await prisma.customEmailTemplate.findUnique({
    where: { applicationId_key: { applicationId, key } },
  });
  if (!row || row.deletedAt !== null) throw templateNotFound(key);
  return row;
}

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

export const customTemplatesService = {
  async list(applicationId: string): Promise<CustomEmailTemplateDto[]> {
    const rows = await prisma.customEmailTemplate.findMany({
      where: { applicationId, deletedAt: null },
      orderBy: { key: 'asc' },
    });
    return rows.map(toDto);
  },

  async get(applicationId: string, key: string): Promise<CustomEmailTemplateDto> {
    return toDto(await findOrThrow(applicationId, key));
  },

  async create(applicationId: string, key: string, fields: DraftFields): Promise<CustomEmailTemplateDto> {
    const count = await prisma.customEmailTemplate.count({ where: { applicationId, deletedAt: null } });
    if (count >= MAX_TEMPLATES_PER_APPLICATION) throw templateLimitReached(MAX_TEMPLATES_PER_APPLICATION);
    const deleted = await prisma.customEmailTemplate.findFirst({
      where: { applicationId, key, deletedAt: { not: null } },
      select: { id: true },
    });
    if (deleted) {
      // Recreating a deleted key reuses its row, so the old versions stay in
      // history and the next publish continues their numbering. It starts as a
      // draft: nothing sends until it is published again.
      const row = await prisma.customEmailTemplate.update({
        where: { id: deleted.id },
        data: {
          ...fields,
          designJson: jsonOrNull(fields.designJson),
          variableSchema: fields.variableSchema as unknown as Prisma.InputJsonValue,
          status: 'draft',
          publishedAt: null,
          deletedAt: null,
        },
      });
      return toDto(row);
    }
    try {
      const row = await prisma.customEmailTemplate.create({
        data: {
          applicationId,
          key,
          ...fields,
          designJson: jsonOrNull(fields.designJson),
          variableSchema: fields.variableSchema as unknown as Prisma.InputJsonValue,
        },
      });
      return toDto(row);
    } catch (e) {
      if (isUniqueViolation(e)) throw templateKeyTaken(key);
      throw e;
    }
  },

  async update(applicationId: string, key: string, patch: Partial<DraftFields>): Promise<CustomEmailTemplateDto> {
    await findOrThrow(applicationId, key);
    const { designJson, variableSchema, ...scalars } = patch;
    const row = await prisma.customEmailTemplate.update({
      where: { applicationId_key: { applicationId, key } },
      data: {
        ...scalars,
        ...(designJson !== undefined && { designJson: jsonOrNull(designJson) }),
        ...(variableSchema !== undefined && {
          variableSchema: variableSchema as unknown as Prisma.InputJsonValue,
        }),
      },
    });
    return toDto(row);
  },

  /** Soft delete: sends stop, published versions stay for history. */
  async remove(applicationId: string, key: string): Promise<void> {
    const { count } = await prisma.customEmailTemplate.updateMany({
      where: { applicationId, key, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw templateNotFound(key);
  },

  /**
   * Snapshot the draft as the next version. Refused without the Application's
   * own transport: publishing is what makes a template sendable, so it is
   * where the operator should learn that it cannot be sent.
   */
  async publish(applicationId: string, key: string, operatorId: string | null): Promise<CustomEmailTemplateDto> {
    const application = await prisma.application.findUniqueOrThrow({ where: { id: applicationId } });
    const transport = customTransport(application);
    if (!transport.eligible) throw transportNotCustom(transport.via);
    if (!transport.fromAddress) throw noFromAddress();

    const draft = await findOrThrow(application.id, key);
    const variableSchema = readVariableSchema(draft.variableSchema);
    const issues = publishIssues({
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText,
      variableSchema,
      linkDomains: draft.linkDomains,
    });
    if (issues.length > 0) throw templateInvalid(issues);

    const row = await prisma.$transaction(async (tx) => {
      // Serialise concurrent publishes of one template; the version number is read under the lock.
      await tx.$queryRaw`SELECT id FROM custom_email_templates WHERE id = ${draft.id} FOR UPDATE`;
      const current = await tx.customEmailTemplate.findUniqueOrThrow({ where: { id: draft.id } });
      const version = current.version + 1;
      const now = new Date();
      await tx.customEmailTemplateVersion.create({
        data: {
          templateId: current.id,
          applicationId: application.id,
          version,
          category: current.category,
          fromName: current.fromName,
          subject: current.subject,
          bodyHtml: current.bodyHtml,
          bodyText: current.bodyText,
          variableSchema: current.variableSchema as Prisma.InputJsonValue,
          linkDomains: current.linkDomains,
          senderDomain: domainOf(transport.fromAddress!),
          publishedBy: operatorId,
          publishedAt: now,
        },
      });
      // `updatedAt` is set to the same instant so a fresh publish reports no unpublished changes.
      return tx.customEmailTemplate.update({
        where: { id: current.id },
        data: { status: 'published', version, publishedAt: now, updatedAt: now },
      });
    });
    return toDto(row);
  },

  /**
   * Render the DRAFT with sample values. Nothing is sent. An undeclared
   * variable renders as its own `{{name}}` token and is listed in
   * `undeclared`, so the preview shows the gap that publish would refuse.
   */
  async preview(
    applicationId: string,
    key: string,
    overrides: Record<string, string> = {},
  ): Promise<{
    subject: string;
    html: string;
    text: string;
    fromName: string | null;
    category: string;
    undeclared: string[];
  }> {
    const draft = await findOrThrow(applicationId, key);
    const schema = readVariableSchema(draft.variableSchema);
    const undeclared = undeclaredNames({ ...draft, variableSchema: schema });
    const values = sampleValues(schema, draft.linkDomains, overrides);
    for (const name of undeclared) values[name] = `{{${name}}}`;
    const rendered = renderCustom(draft, values);
    return { ...rendered, fromName: draft.fromName, category: draft.category, undeclared };
  },

  async settings(applicationId: string, patch?: { recipientsMustBeEndUsers: boolean }): Promise<CustomEmailSettings> {
    const application =
      patch === undefined
        ? await prisma.application.findUniqueOrThrow({ where: { id: applicationId } })
        : await prisma.application.update({
            where: { id: applicationId },
            data: { emailRecipientsMustBeEndUsers: patch.recipientsMustBeEndUsers },
          });
    const transport = customTransport(application);
    return {
      eligible: transport.eligible,
      transport: transport.via,
      fromAddress: transport.fromAddress,
      recipientsMustBeEndUsers: application.emailRecipientsMustBeEndUsers,
      caps: await capsForTenant(application.tenantId),
    };
  },
};
