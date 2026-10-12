/**
 * The money model's operator and buyer routes are described in the published
 * spec: every operation has a summary and a description, and every response
 * field, body property and parameter defined in `apps/api` says what it is.
 * A field of a shared component (`$ref`) is described in `shared-types` and
 * is not judged here.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const ROUTES = [
  /\/payments\/\{paymentId\}\/refunds$/,
  /\/billing\/reporting-currency$/,
  /\/billing\/checkout\/preview$/,
  /\/billing\/events$/,
  /\/billing\/(subscriptions|payments)\/\{entityId\}\/events$/,
  /\/end-users\/\{entityId\}\/billing-events$/,
  /\/billing\/reconciliation$/,
  /\/billing\/price-fallbacks$/,
  /\/plans\/\{planId\}\/prices\/\{currency\}$/,
  /^\/api\/v1\/tenant\/applications\/\{id\}\/coupons/,
  /^\/api\/v1\/billing\/coupons/,
  /^\/api\/v1\/billing\/checkout$/,
  /^\/api\/v1\/billing\/plans$/,
];

interface Schema {
  $ref?: string;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
}

interface Operation {
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; description?: string }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}

/** Every property under `schema` with no description, as a dotted path. A `$ref` is somebody else's schema. */
function undescribed(schema: Schema | undefined, path: string): string[] {
  if (schema === undefined || schema.$ref !== undefined) return [];
  const found: string[] = [];
  for (const branch of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) found.push(...undescribed(branch, path));
  found.push(...undescribed(schema.items, `${path}[]`));
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    const at = `${path}.${key}`;
    if (property.$ref === undefined && !property.description) found.push(at);
    found.push(...undescribed(property, at));
  }
  return found;
}

describe('the money model routes in the published spec', () => {
  let app: FastifyInstance;
  let operations: Array<{ at: string; operation: Operation }>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();
    const spec = (app as unknown as { swagger: () => { paths: Record<string, Record<string, Operation>> } }).swagger();
    operations = Object.entries(spec.paths)
      .filter(([path]) => ROUTES.some((route) => route.test(path)))
      .flatMap(([path, item]) => Object.entries(item).map(([method, operation]) => ({ at: `${method.toUpperCase()} ${path}`, operation })));
  });
  afterAll(async () => {
    await app.close();
  });

  it('finds the routes it is about', () => {
    expect(operations.map((entry) => entry.at).sort()).toEqual([
      'DELETE /api/v1/tenant/applications/{id}/plans/{planId}/prices/{currency}',
      'GET /api/v1/billing/plans',
      'GET /api/v1/tenant/applications/{id}/billing/events',
      'GET /api/v1/tenant/applications/{id}/billing/payments/{entityId}/events',
      'GET /api/v1/tenant/applications/{id}/billing/price-fallbacks',
      'GET /api/v1/tenant/applications/{id}/billing/reconciliation',
      'GET /api/v1/tenant/applications/{id}/billing/reporting-currency',
      'GET /api/v1/tenant/applications/{id}/billing/subscriptions/{entityId}/events',
      'GET /api/v1/tenant/applications/{id}/coupons',
      'GET /api/v1/tenant/applications/{id}/coupons/{code}',
      'GET /api/v1/tenant/applications/{id}/end-users/{entityId}/billing-events',
      'GET /api/v1/tenant/applications/{id}/payments/{paymentId}/refunds',
      'PATCH /api/v1/tenant/applications/{id}/coupons/{code}',
      'POST /api/v1/billing/checkout',
      'POST /api/v1/billing/coupons/validate',
      'POST /api/v1/tenant/applications/{id}/billing/checkout/preview',
      'POST /api/v1/tenant/applications/{id}/coupons',
      'POST /api/v1/tenant/applications/{id}/payments/{paymentId}/refunds',
      'PUT /api/v1/tenant/applications/{id}/billing/reporting-currency',
      'PUT /api/v1/tenant/applications/{id}/plans/{planId}/prices/{currency}',
    ]);
  });

  it('every operation has a summary and a description', () => {
    const missing = operations.filter(({ operation }) => !operation.summary || !operation.description).map((entry) => entry.at);
    expect(missing).toEqual([]);
  });

  it('every response field, body property and parameter defined here is described', () => {
    const missing: string[] = [];
    for (const { at, operation } of operations) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (!status.startsWith('2')) continue;
        const schema = response.content?.['application/json']?.schema;
        missing.push(...undescribed(schema?.properties?.data, `${at} ${status} data`));
      }
      missing.push(...undescribed(operation.requestBody?.content?.['application/json']?.schema, `${at} body`));
      for (const parameter of operation.parameters ?? []) {
        if (!parameter.description) missing.push(`${at} ${parameter.in}:${parameter.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the check sees an undescribed field, and leaves a shared component alone', () => {
    const schema: Schema = {
      properties: {
        refund: { description: 'The refund.', properties: { id: {} } },
        page: { $ref: '#/components/schemas/PageMeta' },
        items: { description: 'Rows.', items: { properties: { amount: {} } } },
      },
    };
    expect(undescribed(schema, 'data')).toEqual(['data.refund.id', 'data.items[].amount']);
  });
});
