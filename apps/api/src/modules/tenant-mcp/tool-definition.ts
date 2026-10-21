/**
 * One Zod schema per tool: it validates the arguments, types the handler and
 * is what `tools/list` publishes, so the three cannot drift apart.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RekeyError } from '../../lib/error.js';
import { MINOR_UNITS, type OperatorTool, type OperatorToolAnnotations, type OperatorToolContext } from './operator-tools.js';

export { MINOR_UNITS };

const ID_MAX = 200;

export const ApplicationIdArg = z.string().min(1).max(ID_MAX).describe('The Application id, from list_applications.');
export const CurrencyArg = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'currency must be a three-letter ISO 4217 code')
  .describe('ISO 4217 code, any case, such as USD or INR.');

/** Free-form JSON an operator stores on a record, typed all the way down. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);
export const MetadataArg = z.record(JsonValueSchema);

function refuseInvalid(tool: string, issues: readonly z.ZodIssue[]): never {
  const detail = issues.map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; ');
  throw new RekeyError({
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    message: `Invalid arguments for ${tool}: ${detail}.`,
    fix: `Check the arguments against ${tool}'s inputSchema in tools/list.`,
  });
}

/** The JSON Schema `tools/list` publishes for a tool's arguments. */
function inputSchemaOf(schema: z.AnyZodObject): OperatorTool['inputSchema'] {
  const generated = zodToJsonSchema(schema, { $refStrategy: 'none', errorMessages: false, pipeStrategy: 'input' }) as {
    properties?: OperatorTool['inputSchema']['properties'];
    required?: string[];
  };
  return {
    type: 'object',
    properties: generated.properties ?? {},
    additionalProperties: false,
    ...(generated.required !== undefined && generated.required.length > 0 && { required: generated.required }),
  };
}

export interface ToolDefinition<Schema extends z.AnyZodObject, Output> {
  name: string;
  description: string;
  /** A strict object. Describe each field: the description is what an agent reads. */
  args: Schema;
  write?: boolean;
  admin?: boolean;
  /** The lowest workspace role that may call it. See `OperatorTool.minRole`. */
  minRole?: OperatorTool['minRole'];
  annotations?: OperatorToolAnnotations;
  /** Runs on the raw arguments before they are parsed, to refuse a removed field by name. */
  refuse?: (raw: Readonly<Record<string, unknown>>) => void;
  run: (ctx: OperatorToolContext, input: z.infer<Schema>) => Promise<Output>;
}

/**
 * Build an operator tool from a Zod schema and a typed handler.
 *
 * @example
 * defineTool({
 *   name: 'get_reporting_currency',
 *   description: 'The currency an Application reports in.',
 *   args: z.object({ applicationId: ApplicationIdArg }).strict(),
 *   run: async (ctx, { applicationId }) => ({ reportingCurrency: 'USD' }),
 * });
 */
export function defineTool<Schema extends z.AnyZodObject, Output>(definition: ToolDefinition<Schema, Output>): OperatorTool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: inputSchemaOf(definition.args),
    ...(definition.write !== undefined && { write: definition.write }),
    ...(definition.admin !== undefined && { admin: definition.admin }),
    ...(definition.minRole !== undefined && { minRole: definition.minRole }),
    ...(definition.annotations !== undefined && { annotations: definition.annotations }),
    handler: async (ctx, raw) => {
      definition.refuse?.(raw);
      const parsed = definition.args.safeParse(raw);
      if (!parsed.success) refuseInvalid(definition.name, parsed.error.issues);
      return definition.run(ctx, parsed.data as z.infer<Schema>);
    },
  };
}

/** A field the money model removed, and what replaced it. */
export function removedField(tool: string, field: string, fix: string): RekeyError {
  return new RekeyError({
    statusCode: 400,
    code: 'BILLING_FIELD_REMOVED',
    message: `${tool} no longer takes \`${field}\`.`,
    fix,
  });
}
