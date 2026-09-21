/**
 * `app.close()` quits the dedicated Redis subscriber of both in-process
 * caches (operator auth, org-role catalog), so a graceful stop leaves no
 * connection behind.
 */

import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import * as operatorAuth from '../src/lib/operator-auth-cache.js';
import * as orgRoles from '../src/lib/organization-role-cache.js';
import { prisma } from '../src/lib/prisma.js';

class FakeSubscriber extends EventEmitter {
  quits = 0;
  subscribe(): Promise<number> {
    return Promise.resolve(1);
  }
  quit(): Promise<string> {
    this.quits++;
    this.emit('end');
    return Promise.resolve('OK');
  }
}

class FakeBus {
  subscribers: FakeSubscriber[] = [];
  publish(): Promise<number> {
    return Promise.resolve(0);
  }
  duplicate(): FakeSubscriber {
    const s = new FakeSubscriber();
    this.subscribers.push(s);
    return s;
  }
}

describe('cache subscribers on shutdown', () => {
  afterAll(() => {
    operatorAuth.__usePubSubForTests(undefined);
    orgRoles.__usePubSubForTests(undefined);
  });

  it('app.close() quits both subscribers', async () => {
    const authBus = new FakeBus();
    const roleBus = new FakeBus();
    operatorAuth.__usePubSubForTests(authBus);
    orgRoles.__usePubSubForTests(roleBus);
    const app = await buildApp({ logger: false });
    await app.ready();
    // Each cache subscribes lazily, on first use.
    operatorAuth.getCachedAuth('op', 'ws', undefined);
    // Its catalog read is stubbed: this test is about the connection, and the
    // shared client's delegate may carry another file's spy.
    const delegate = prisma.organizationRoleDef as unknown as Record<string, unknown>;
    const findMany = delegate.findMany;
    delegate.findMany = async () => [];
    try {
      await orgRoles.getOrganizationRoles('no-such-app');
    } finally {
      delegate.findMany = findMany;
    }
    expect(authBus.subscribers).toHaveLength(1);
    expect(roleBus.subscribers).toHaveLength(1);

    await app.close();
    expect(authBus.subscribers[0]!.quits).toBe(1);
    expect(roleBus.subscribers[0]!.quits).toBe(1);
  });
});
