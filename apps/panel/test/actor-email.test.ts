/**
 * The panel names the operator who acted on an end-user.
 *
 * The API now resolves `actorEmail` on every security event when the log is
 * read (`withActorEmails` in apps/api). The end-user Security and Overview
 * tabs used to print "operator" for every operator action, and the audit log
 * resolved ids against the current member list, which could not name anyone
 * who had left. These pin the panel half: the API's answer is used as is,
 * without the old lookups, and the words shown for each actor type.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({ apiGet: (...args: unknown[]) => apiGet(...args) }));

const { actorLabel, eventDetails, eventSummary, resolveActorEmails } = await import('@/lib/security-events');

beforeEach(() => apiGet.mockReset());

describe('resolveActorEmails', () => {
  it("uses the API's actorEmail and makes no lookups of its own", async () => {
    const emails = await resolveActorEmails([
      { actorType: 'operator', actorId: 'op1', actorEmail: 'ops@example.com', applicationId: 'app1' },
      { actorType: 'end_user', actorId: 'eu1', actorEmail: 'eu@example.com', applicationId: 'app1' },
      { actorType: 'system', actorId: null, actorEmail: null, applicationId: 'app1' },
    ]);
    expect(emails.get('op1')).toBe('ops@example.com');
    expect(emails.get('eu1')).toBe('eu@example.com');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('treats null as the API saying there is no one to name, not as missing', async () => {
    const emails = await resolveActorEmails([
      { actorType: 'operator', actorId: 'gone', actorEmail: null, applicationId: 'app1' },
    ]);
    expect(emails.has('gone')).toBe(false);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('falls back to the member list only for an event from an older API (no field at all)', async () => {
    apiGet.mockResolvedValue({ items: [{ tenantUserId: 'op2', email: 'old@example.com' }] });
    const emails = await resolveActorEmails([{ actorType: 'operator', actorId: 'op2', applicationId: 'app1' }]);
    expect(emails.get('op2')).toBe('old@example.com');
    expect(apiGet).toHaveBeenCalledTimes(1);
  });
});

describe('actorLabel, on one end-user\'s tabs', () => {
  const me = 'eu-self';

  it('names an operator by email', () => {
    expect(actorLabel({ actorType: 'operator', actorId: 'op1', actorEmail: 'ops@example.com' }, me)).toBe(
      'ops@example.com',
    );
  });

  it('falls back to the operator id rather than a bare "operator"', () => {
    expect(actorLabel({ actorType: 'operator', actorId: 'op1', actorEmail: null }, me)).toBe('operator op1');
  });

  it('calls the subject "this user", and another end-user by email', () => {
    expect(actorLabel({ actorType: 'end_user', actorId: me, actorEmail: 'me@example.com' }, me)).toBe('this user');
    expect(actorLabel({ actorType: 'end_user', actorId: 'eu2', actorEmail: 'two@example.com' }, me)).toBe(
      'two@example.com',
    );
  });

  it('keeps system as system, and shows an unknown actor type with its id', () => {
    expect(actorLabel({ actorType: 'system', actorId: null }, me)).toBe('system');
    expect(actorLabel({ actorType: 'api_key', actorId: 'key1' }, me)).toBe('api key key1');
  });
});

// What `app.credits_granted_by_api_key` records (apps/api credits.routes.ts):
// the actor is `system`, and the key is only in metadata.
const KEY_GRANT = {
  actorType: 'system',
  actorId: 'key-cuid',
  metadata: {
    apiKeyId: 'key-cuid',
    apiKeyName: 'Backend',
    keyPrefix: 'rk_live_ab12',
    amount: 250,
    reason: 'GRANT',
    idempotencyKey: 'order-7',
    ledgerEntryId: 'le1',
    balance: 250,
  },
};

describe('a credit grant made with an API key', () => {
  it('names the key as the actor, not "system"', () => {
    expect(actorLabel(KEY_GRANT, 'eu-self')).toBe('API key Backend (rk_live_ab12)');
    expect(actorLabel({ ...KEY_GRANT, metadata: { keyPrefix: 'rk_live_ab12' } }, 'eu-self')).toBe(
      'API key rk_live_ab12',
    );
  });

  it('shows the amount on the Security tab detail', () => {
    expect(eventSummary(KEY_GRANT.metadata)).toBe('amount: 250 · reason: GRANT');
  });

  it('shows the key and the amount as audit-log chips', () => {
    expect(eventDetails(KEY_GRANT.metadata).map((d) => `${d.label}: ${d.value}`)).toEqual([
      'key: Backend',
      'key prefix: rk_live_ab12',
      'amount: 250',
      'reason: GRANT',
    ]);
  });
});
