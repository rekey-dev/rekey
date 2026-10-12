/**
 * Shared by the CLI test files: the compiled binary run in a subprocess, a
 * stub HTTP server that records what it was sent, and fixtures checked against
 * the schemas the API serialises with.
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const cliEntry = path.resolve(here, '..', 'dist', 'index.js');

export const OPERATOR_TOKEN = 'rp_op_test';
export const ADMIN_KEY = 'x'.repeat(40);

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the compiled CLI. Credentials in the caller's own environment never reach it. */
export function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn('node', [cliEntry, ...args], {
      env: {
        ...process.env,
        REKEY_URL: '',
        SUPER_ADMIN_KEY: '',
        REKEY_OPERATOR_TOKEN: '',
        REKEY_SECRET: '',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export interface RecordedRequest {
  /** `METHOD /path?query`. */
  key: string;
  body: unknown;
  auth: string | undefined;
}

export interface StubServer {
  url: string;
  close: () => Promise<void>;
  reset: () => void;
  /** Answer `key` with a success envelope around `data`. */
  ok: (key: string, data: unknown, status?: number) => void;
  /** Answer `key` with an error envelope. */
  error: (key: string, status: number, error: { code: string; message: string; fix?: string }) => void;
  requests: RecordedRequest[];
}

/** A stub API. A request with no answer set gets a 404 `STUB_MISS`, so a wrong path fails the test. */
export function startStubServer(): Promise<StubServer> {
  return new Promise((resolve) => {
    const responses = new Map<string, { status: number; body: unknown }>();
    const requests: RecordedRequest[] = [];
    const server: Server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        requests.push({ key, body: raw === '' ? undefined : JSON.parse(raw), auth: req.headers.authorization });
        const answer = responses.get(key) ?? {
          status: 404,
          body: { success: false, error: { code: 'STUB_MISS', message: `no answer set for ${key}` } },
        };
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      });
    });
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
        reset: () => {
          responses.clear();
          requests.length = 0;
        },
        ok: (key, data, status = 200) => responses.set(key, { status, body: { success: true, data } }),
        error: (key, status, error) => responses.set(key, { status, body: { success: false, error } }),
        requests,
      });
    });
  });
}

// The CLI does not depend on `@rekey.dev/shared-types`, but `@rekey.dev/node`
// does, so the schemas resolve from there.
const fromNodeSdk = createRequire(createRequire(import.meta.url).resolve('@rekey.dev/node'));
// A plain path, not a file URL: vite cannot load a URL whose path has an escaped space.
const schemas = (await import(/* @vite-ignore */ fromNodeSdk.resolve('@rekey.dev/shared-types'))) as Record<
  string,
  { parse: (value: unknown) => unknown }
>;

/**
 * A fixture, returned as given once the named shared-types schema accepts it.
 * A fixture the real serialiser could not have produced fails the test file.
 */
export function valid<T>(schemaName: string, fixture: T): T {
  const schema = schemas[schemaName];
  if (schema === undefined) throw new Error(`@rekey.dev/shared-types exports no ${schemaName}`);
  schema.parse(fixture);
  return fixture;
}

export function paged<T>(items: T[], limit = 50, offset = 0, total = items.length) {
  return { items, page: { total, limit, offset, hasMore: offset + items.length < total } };
}

const AT = '2026-10-01T09:00:00.000Z';

export function price(over: Record<string, unknown> = {}) {
  return valid('PlanPriceDtoSchema', {
    id: 'pp_usd',
    currency: 'USD',
    amount: 1900,
    countries: [] as string[],
    isDefault: true,
    archived: false as const,
    registration: { status: 'REGISTERED', error: null as string | null },
    amountEditable: false,
    liveSubscriptions: 0,
    openCheckouts: 0,
    ...over,
  });
}

export function plan(over: Record<string, unknown> = {}) {
  const prices = (over.prices as Array<ReturnType<typeof price>> | undefined) ?? [price()];
  const defaultPrice = prices.find((each) => each.isDefault);
  return valid('PlanDtoSchema', {
    id: 'plan_pro',
    applicationId: 'app_1',
    slug: 'pro',
    name: 'Pro',
    kind: 'SUBSCRIPTION',
    interval: 'MONTH',
    isFree: false,
    trialDays: null,
    licenseKind: null,
    licenseSeatsAllowed: null,
    licenseDurationDays: null,
    meterSlug: null,
    creditsAmount: null,
    price: null,
    prices,
    defaultPriceId: defaultPrice?.id ?? null,
    localPrices: 'INHERIT',
    active: true,
    registrationStatus: 'REGISTERED',
    registrationError: null,
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
}

export function coupon(over: Record<string, unknown> = {}) {
  return valid('CouponDtoSchema', {
    id: 'cpn_1',
    applicationId: 'app_1',
    code: 'launch',
    discountType: 'PERCENT',
    basisPoints: 1500 as number | null,
    amounts: [] as Array<{ currency: string; amountOff: number }>,
    currencies: [] as string[],
    coveredCurrencies: null as string[] | null,
    planSlugs: [] as string[],
    active: true,
    startsAt: null as string | null,
    endsAt: null as string | null,
    maxRedemptions: null as number | null,
    maxRedemptionsPerUser: null as number | null,
    metadata: {},
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });
}

export function credential(over: Record<string, unknown> = {}) {
  return valid('BillingCredentialDtoSchema', {
    provider: 'stripe',
    configured: true as const,
    enabled: true,
    mode: 'live',
    countries: [] as string[],
    currencies: ['USD'],
    unsupportedCurrencies: [] as string[],
    priority: 100,
    webhookConfigured: true,
    ...over,
  });
}
