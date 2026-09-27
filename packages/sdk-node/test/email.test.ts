/**
 * `rekey.email.send()` against a fake API: the request it makes, the result it
 * returns, and the typed errors it surfaces.
 */

import { describe, expect, it, vi } from 'vitest';
import { Rekey, RekeyError, emailVariableIssues, isEmailSendError } from '../src/index.js';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: typeof fetch): Rekey {
  return new Rekey({ apiUrl: 'https://api.example.com', secretKey: 'rp_live_token', fetch: fetchImpl });
}

describe('rekey.email.send', () => {
  it('posts the template key, recipient, variables and idempotency key, and returns the result', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        success: true,
        data: { id: 'log_1', status: 'sent', template: 'order_shipped', version: 3, messageId: 're_1' },
      }),
    );
    const result = await client(fetchSpy as unknown as typeof fetch).email.send({
      template: 'order_shipped',
      to: 'buyer@example.com',
      variables: { orderNumber: 'A-1042', itemCount: 2 },
      version: 3,
      idempotencyKey: 'order-shipped:A-1042',
    });

    expect(result).toEqual({ id: 'log_1', status: 'sent', template: 'order_shipped', version: 3, messageId: 're_1' });
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.example.com/api/v1/email/send');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer rp_live_token');
    expect(JSON.parse(init.body as string)).toEqual({
      template: 'order_shipped',
      to: 'buyer@example.com',
      variables: { orderNumber: 'A-1042', itemCount: 2 },
      version: 3,
      idempotencyKey: 'order-shipped:A-1042',
    });
  });

  it('resolves a suppressed send rather than throwing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(202, { success: true, data: { id: 'log_2', status: 'suppressed', template: 'receipt', version: 1 } }),
    );
    const result = await client(fetchSpy as unknown as typeof fetch).email.send({ template: 'receipt', to: 'gone@example.com' });
    expect(result.status).toBe('suppressed');
    expect(result.messageId).toBeUndefined();
  });

  it('throws a typed error with the variable issues', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        success: false,
        error: {
          code: 'EMAIL_VARIABLES_INVALID',
          message: '2 variable problems against template "order_shipped" version 3.',
          fix: 'Correct each entry in `details.issues`.',
          details: {
            issues: [
              { path: 'variables.trackingUrl', message: 'must use https.' },
              { path: 'variables.coupon', message: 'is not declared by this template.' },
            ],
          },
          requestId: 'req_1',
        },
      }),
    );
    const err = await client(fetchSpy as unknown as typeof fetch)
      .email.send({ template: 'order_shipped', to: 'b@example.com', variables: { coupon: 'x' } })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RekeyError);
    expect(isEmailSendError(err)).toBe(true);
    expect((err as RekeyError).statusCode).toBe(400);
    expect((err as RekeyError).requestId).toBe('req_1');
    expect(emailVariableIssues(err).map((i) => i.path)).toEqual(['variables.trackingUrl', 'variables.coupon']);
  });

  it('carries retryAfterSeconds on a cap refusal, and leaves generic codes out of isEmailSendError', async () => {
    const capped = vi.fn().mockResolvedValue(
      jsonResponse(
        429,
        {
          success: false,
          error: { code: 'EMAIL_RATE_LIMITED', message: 'cap', fix: 'wait', retryAfterSeconds: 1800 },
        },
        { 'retry-after': '1800' },
      ),
    );
    const err = await client(capped as unknown as typeof fetch)
      .email.send({ template: 'order_shipped', to: 'b@example.com' })
      .catch((e: unknown) => e);
    expect(isEmailSendError(err)).toBe(true);
    expect((err as RekeyError).retryAfterSeconds).toBe(1800);
    expect(emailVariableIssues(err)).toEqual([]);

    const scope = vi.fn().mockResolvedValue(
      jsonResponse(403, { success: false, error: { code: 'API_KEY_SCOPE_INSUFFICIENT', message: 'm', fix: 'f' } }),
    );
    const scopeErr = await client(scope as unknown as typeof fetch)
      .email.send({ template: 'order_shipped', to: 'b@example.com' })
      .catch((e: unknown) => e);
    expect(scopeErr).toBeInstanceOf(RekeyError);
    expect(isEmailSendError(scopeErr)).toBe(false);
  });
});
