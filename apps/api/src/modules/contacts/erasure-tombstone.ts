/**
 * After an erasure, a browser must not be able to put the person straight
 * back on a list by typing their address: they asked to be forgotten, and a
 * stranger's form post is not their consent. Erasure deletes the suppression
 * rows that would otherwise block it, so it leaves a tombstone instead.
 *
 * The tombstone holds an HMAC of the address, keyed by the deployment's
 * `JWT_SECRET` and scoped to the Application, never the address, and expires
 * after `ERASURE_TOMBSTONE_DAYS`. Anyone holding a candidate address and the
 * key could still test it, which is why it expires rather than lasting.
 * Your own server, speaking for itself, is not blocked by it.
 */

import { createHmac } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';

type Tx = Prisma.TransactionClient;

export const ERASURE_TOMBSTONE_DAYS = 30;

export function addressHash(applicationId: string, address: string): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`contact-erasure:${applicationId}:${address.trim().toLowerCase()}`)
    .digest('hex');
}

export async function writeTombstones(tx: Tx, applicationId: string, addresses: readonly string[]): Promise<void> {
  if (addresses.length === 0) return;
  const expiresAt = new Date(Date.now() + ERASURE_TOMBSTONE_DAYS * 86_400_000);
  for (const address of new Set(addresses.map((a) => a.toLowerCase()))) {
    const hash = addressHash(applicationId, address);
    await tx.contactErasureTombstone.upsert({
      where: { applicationId_addressHash: { applicationId, addressHash: hash } },
      create: { applicationId, addressHash: hash, expiresAt },
      update: { expiresAt },
    });
  }
}

export async function tombstoned(tx: Tx, applicationId: string, address: string): Promise<boolean> {
  const row = await tx.contactErasureTombstone.findUnique({
    where: { applicationId_addressHash: { applicationId, addressHash: addressHash(applicationId, address) } },
    select: { expiresAt: true },
  });
  return row !== null && row.expiresAt > new Date();
}
