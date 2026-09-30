/**
 * Erasing a contact, and what a DSAR export says about one.
 *
 * A contact is HARD-DELETED with its memberships and submissions: nothing
 * financial hangs off it, so unlike an end user there is nothing to keep a
 * tombstone for. Outbound webhook deliveries that named it are KEPT, with the
 * address, name and submitted fields rewritten, matched by the contact id at
 * the fixed places Rekey's own emit sites put it (`data.contact.id`).
 *
 * `eraseEndUser` calls `eraseContactsByAddress` inside its own transaction, so
 * erasing an end user erases the contact at the same address in the same
 * Application.
 */

import type { Prisma } from '@prisma/client';
import type { EndUserExportContact } from '@rekey.dev/shared-types';
import { prisma } from '../../lib/prisma.js';
import { writeTombstones } from './erasure-tombstone.js';

type Tx = Prisma.TransactionClient;

const SCRUB_CHUNK = 500;

export interface ContactErasure {
  contactIds: string[];
  deliveriesScrubbed: number;
}

type DeliveryPayload = {
  data?: { contact?: Record<string, unknown>; submission?: Record<string, unknown> };
};

/** The address becomes a non-routable tombstone (`.invalid`, RFC 2606), like an erased end user's. */
function scrubbed(payload: DeliveryPayload, contactId: string): DeliveryPayload {
  const data = payload.data ?? {};
  const contact = { ...data.contact, email: `erased+${contactId}@deleted.invalid` };
  if ('name' in contact) contact.name = null;
  const submission = data.submission ? { ...data.submission, fields: null } : undefined;
  return { ...payload, data: { ...data, contact, ...(submission && { submission }) } };
}

/**
 * Raw SQL for the write, as in end-user erasure: one statement per chunk, and
 * `updated_at` is left alone so the scrub does not restart the delivery's
 * retention clock.
 */
async function scrubContactDeliveries(tx: Tx, applicationId: string, contactIds: string[]): Promise<number> {
  if (contactIds.length === 0) return 0;
  const ids = (
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM webhook_deliveries
      WHERE application_id = ${applicationId} AND payload #>> '{data,contact,id}' = ANY(${contactIds})`
  ).map((r) => r.id);
  for (let i = 0; i < ids.length; i += SCRUB_CHUNK) {
    const rows = await tx.webhookDelivery.findMany({
      where: { id: { in: ids.slice(i, i + SCRUB_CHUNK) } },
      select: { id: true, payload: true },
    });
    const updates = rows.map((row) => {
      const payload = row.payload as DeliveryPayload;
      return { id: row.id, payload: scrubbed(payload, String(payload.data?.contact?.id)) };
    });
    await tx.$executeRaw`
      UPDATE webhook_deliveries AS d SET payload = v.payload
      FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS v(id text, payload jsonb)
      WHERE d.id = v.id`;
  }
  return ids.length;
}

async function eraseContacts(tx: Tx, applicationId: string, contactIds: string[]): Promise<ContactErasure> {
  const deliveriesScrubbed = await scrubContactDeliveries(tx, applicationId, contactIds);
  await tx.contact.deleteMany({ where: { applicationId, id: { in: contactIds } } });
  return { contactIds, deliveriesScrubbed };
}

/**
 * Erase every contact of this Application at one of these (lowercased)
 * addresses, and tombstone the addresses so a browser cannot capture them
 * again straight away (see erasure-tombstone.ts).
 */
export async function eraseContactsByAddress(
  tx: Tx,
  applicationId: string,
  addresses: readonly string[],
): Promise<ContactErasure> {
  if (addresses.length === 0) return { contactIds: [], deliveriesScrubbed: 0 };
  await writeTombstones(tx, applicationId, addresses);
  const contacts = await tx.contact.findMany({
    where: { applicationId, email: { in: [...addresses] } },
    select: { id: true },
  });
  return eraseContacts(tx, applicationId, contacts.map((c) => c.id));
}

/** Erase one contact by id. Null when the Application has no such contact. */
export async function eraseContact(applicationId: string, contactId: string): Promise<ContactErasure | null> {
  return prisma.$transaction(async (tx) => {
    const contact = await tx.contact.findFirst({
      where: { id: contactId, applicationId },
      select: { id: true, email: true },
    });
    if (!contact) return null;
    await writeTombstones(tx, applicationId, [contact.email]);
    return eraseContacts(tx, applicationId, [contact.id]);
  });
}

/**
 * The contacts at an end user's addresses for a DSAR export: every
 * membership with its consent proof, and every submission. Pass the same
 * addresses erasure covers (`personAddresses`).
 */
export async function contactsForExport(
  applicationId: string,
  addresses: readonly string[],
): Promise<EndUserExportContact[]> {
  const contacts = await prisma.contact.findMany({
    where: { applicationId, email: { in: addresses.map((a) => a.toLowerCase()) } },
    include: {
      memberships: { include: { list: { select: { key: true, name: true } } }, orderBy: { createdAt: 'asc' } },
      submissions: { include: { list: { select: { key: true } } }, orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (contacts.length === 0) return [];
  const agreed = contacts.flatMap((c) =>
    c.memberships.filter((m) => m.consentVersion !== null).map((m) => ({ listId: m.listId, version: m.consentVersion! })),
  );
  const versions =
    agreed.length === 0
      ? []
      : await prisma.contactListConsentVersion.findMany({
          where: { OR: agreed },
          select: { listId: true, version: true, text: true },
        });
  const textOf = (listId: string, version: number | null): string | null =>
    versions.find((v) => v.listId === listId && v.version === version)?.text ?? null;
  return contacts.map((contact) => ({
    id: contact.id,
    email: contact.email,
    name: contact.name,
    createdAt: contact.createdAt.toISOString(),
    memberships: contact.memberships.map((m) => ({
      listKey: m.list.key,
      listName: m.list.name,
      status: m.status,
      source: m.source,
      consentVersion: m.consentVersion,
      consentText: textOf(m.listId, m.consentVersion),
      consentAt: m.consentAt?.toISOString() ?? null,
      consentIpPrefix: m.consentIpPrefix,
      sourceUrl: m.sourceUrl,
      unsubscribedAt: m.unsubscribedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
    })),
    submissions: contact.submissions.map((s) => ({
      listKey: s.list.key,
      fields: s.fields as Record<string, unknown>,
      createdAt: s.createdAt.toISOString(),
    })),
  }));
}
