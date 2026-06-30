/**
 * Tiny Zod → JSON Schema shim sufficient for MCP tool input descriptors.
 *
 * The MCP `tools/list` response wants each tool's `inputSchema` as a JSON
 * Schema object. We only use a small Zod subset (objects of strings /
 * booleans / optionals with descriptions), so reaching for `zod-to-json-schema`
 * as a full dependency is overkill — this 30-line implementation covers it
 * and stays auditable. If the tool surface grows, swap in the npm package.
 */

import { z } from 'zod';

interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  enum?: string[];
}

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  // Object — the common top-level case for tool args.
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const inner = unwrap(value);
      properties[key] = zodToJsonSchema(inner.schema);
      if (inner.description) properties[key].description = inner.description;
      if (!inner.optional) required.push(key);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 && { required }),
    };
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...(schema.options as string[])] };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: zodToJsonSchema(schema.element) };
  }
  // Fallback — let MCP receive an open object.
  return { type: 'object' };
}

function unwrap(s: z.ZodTypeAny): {
  schema: z.ZodTypeAny;
  optional: boolean;
  description: string | undefined;
} {
  let optional = false;
  let description: string | undefined;
  let cur = s;
  // Unwrap z.optional() and pick up .describe() metadata.
  while (true) {
    description = description ?? cur.description;
    if (cur instanceof z.ZodOptional) {
      optional = true;
      cur = cur.unwrap();
    } else {
      break;
    }
  }
  return { schema: cur, optional, description };
}
