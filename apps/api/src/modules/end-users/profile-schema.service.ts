import { Prisma } from '@prisma/client';
import { ProfileSchemaSchema, type ProfileField } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { RekeyError } from '../../lib/error.js';
import { readProfileSchema } from './profile-values.js';

/** An Application's profile fields and the version a PUT must name to replace them. */
export interface VersionedProfileSchema {
  fields: ProfileField[];
  version: number;
}

/**
 * Read the schema inside a transaction. `lock: 'update'` for the writer that
 * replaces it; `lock: 'share'` for an answer write, so a schema replacement
 * waits for in-flight answers and they wait for it, and neither sees the other
 * half done.
 */
export async function readSchemaLocked(
  tx: Prisma.TransactionClient,
  applicationId: string,
  lock: 'update' | 'share',
): Promise<VersionedProfileSchema> {
  const mode = lock === 'update' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
  const [row] = await tx.$queryRaw<Array<{ profile_schema: unknown; profile_schema_version: number }>>`
    SELECT "profile_schema", "profile_schema_version" FROM "applications" WHERE "id" = ${applicationId} ${mode}`;
  return { fields: readProfileSchema(row?.profile_schema), version: row?.profile_schema_version ?? 0 };
}

/**
 * The Application's profile fields with their version.
 *
 * @example
 *   const { fields, version } = await readSchema(app.id);
 */
export async function readSchema(applicationId: string): Promise<VersionedProfileSchema> {
  const app = await prisma.application.findUniqueOrThrow({
    where: { id: applicationId },
    select: { profileSchema: true, profileSchemaVersion: true },
  });
  return { fields: readProfileSchema(app.profileSchema), version: app.profileSchemaVersion };
}

function parseSchema(input: unknown): ProfileField[] {
  const parsed = ProfileSchemaSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new RekeyError({
    statusCode: 400,
    code: 'PROFILE_SCHEMA_INVALID',
    message: 'The profile schema is not valid.',
    fix: 'Send an array of at most 50 fields with unique, unreserved keys; `details.issues` names each problem.',
    details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
  });
}

async function answersFor(tx: Prisma.TransactionClient, applicationId: string, key: string): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM "end_users" WHERE "application_id" = ${applicationId} AND "profile" ? ${key}`;
  return Number(row?.n ?? 0);
}

async function picksOf(
  tx: Prisma.TransactionClient,
  applicationId: string,
  key: string,
  options: string[],
): Promise<Array<{ option: string; answers: number }>> {
  const rows = await tx.$queryRaw<Array<{ option: string; n: bigint }>>`
    SELECT "profile"->>${key} AS option, count(*) AS n FROM "end_users"
     WHERE "application_id" = ${applicationId} AND "profile"->>${key} = ANY(${options})
     GROUP BY 1`;
  return rows.map((r) => ({ option: r.option, answers: Number(r.n) }));
}

/**
 * Replace the Application's profile fields, in one transaction holding the
 * Application row, so no answer can land against the old schema between the
 * checks and the write. Refuses: a schema that does not parse; a stale
 * `expectedVersion`; removing or retyping a field that has answers; removing a
 * select option that users picked. Returns the stored fields and new version.
 *
 * @example
 *   const { version } = await putSchema(app.id, fields, 3);
 */
export async function putSchema(
  applicationId: string,
  input: unknown,
  expectedVersion?: number,
): Promise<VersionedProfileSchema> {
  const next = parseSchema(input);
  return prisma.$transaction(async (tx) => {
    const current = await readSchemaLocked(tx, applicationId, 'update');
    if (expectedVersion !== undefined && expectedVersion !== current.version) {
      throw new RekeyError({
        statusCode: 409,
        code: 'PROFILE_SCHEMA_CHANGED',
        message: `The profile fields changed since version ${expectedVersion} was read; they are at version ${current.version}.`,
        fix: 'Read the fields again (GET .../profile-schema), reapply your change to them, and send the new `version`.',
        details: { expected: expectedVersion, current: current.version },
      });
    }
    const nextByKey = new Map(next.map((f) => [f.key, f]));

    const locked: Array<{ key: string; answers: number }> = [];
    for (const f of current.fields.filter((f) => nextByKey.get(f.key)?.type !== f.type)) {
      const answers = await answersFor(tx, applicationId, f.key);
      if (answers > 0) locked.push({ key: f.key, answers });
    }
    if (locked.length > 0) {
      throw new RekeyError({
        statusCode: 409,
        code: 'PROFILE_FIELD_KEY_IMMUTABLE',
        message: `${locked.map((l) => `"${l.key}"`).join(', ')} already has answers, so it cannot be removed, renamed or retyped.`,
        fix: 'Keep the field with its key and type and change its label instead. `details.fields` counts the answers for each.',
        details: { fields: locked },
      });
    }

    const inUse: Array<{ key: string; option: string; answers: number }> = [];
    for (const f of current.fields.filter((f) => f.type === 'select' && nextByKey.get(f.key)?.type === 'select')) {
      const kept = new Set(nextByKey.get(f.key)!.options);
      const dropped = f.options!.filter((o) => !kept.has(o));
      if (dropped.length === 0) continue;
      for (const pick of await picksOf(tx, applicationId, f.key, dropped)) inUse.push({ key: f.key, ...pick });
    }
    if (inUse.length > 0) {
      throw new RekeyError({
        statusCode: 409,
        code: 'PROFILE_OPTION_IN_USE',
        message: `Users picked ${inUse.map((u) => `"${u.option}" for "${u.key}"`).join(', ')}, so those options cannot be removed.`,
        fix: 'Keep those options, or first change those users\' answers (PATCH .../end-users/:euid/profile). `details.options` counts the users for each.',
        details: { options: inUse },
      });
    }

    const updated = await tx.application.update({
      where: { id: applicationId },
      data: {
        profileSchema: next as unknown as Prisma.InputJsonValue,
        profileSchemaVersion: { increment: 1 },
      },
      select: { profileSchemaVersion: true },
    });
    return { fields: next, version: updated.profileSchemaVersion };
  });
}
