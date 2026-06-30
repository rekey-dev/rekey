/**
 * QR domain service — CRUD + tier enforcement.
 *
 * Enforcement reads come from ReliPay, never from local state:
 *   - QR count cap  → `billing.getEntitlements().features.max_qr_codes`
 *                     (Free users have no subscription → no entitlement →
 *                      we apply the Free default).
 *   - scan cap      → enforced by ReliPay at `usage.record` time as a hard
 *                     cap on the `qr_scans` meter (402 USAGE_QUOTA_EXCEEDED);
 *                     we just record + surface the error.
 *   - analytics     → `features.analytics === true`.
 *
 * A QR can belong to a personal user OR a team (ReliPay organization). The
 * `subject` we pass to ReliPay reads/writes follows that: org QRs meter +
 * gate against the org's pooled entitlements; personal QRs against the user.
 */

import type { ReliPay } from '@relipay/node';
import { store, freshSlug, type QrCode, type Scope } from './store.js';
import {
  METER_QR_SCANS,
  FEAT_ANALYTICS,
  FEAT_MAX_QRS,
  FREE_MAX_QRS,
} from './constants.js';

export class QrError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
    this.name = 'QrError';
  }
}

/** A resolved billing subject for ReliPay reads/writes. */
export interface Subject {
  accessToken: string;
  /** end-user id (always known) */
  endUserId: string;
  /** active org id, when the user is operating inside a team workspace */
  organizationId: string | null;
}

function scopeOf(subject: Subject): Scope {
  return { ownerEndUserId: subject.endUserId, organizationId: subject.organizationId };
}

/**
 * Resolve the effective tier limits + flags for a subject from ReliPay.
 * Falls back to Free defaults when the subject has no active subscription.
 */
export async function resolveEntitlements(
  relipay: ReliPay,
  subject: Subject,
): Promise<{ maxQrs: number; analytics: boolean; raw: Record<string, boolean | number | string> }> {
  const ent = await relipay.billing.getEntitlements(
    subject.accessToken,
    subject.organizationId ? { organizationId: subject.organizationId } : undefined,
  );
  const features = ent.features;
  const maxFromPlan = typeof features[FEAT_MAX_QRS] === 'number' ? (features[FEAT_MAX_QRS] as number) : null;
  return {
    maxQrs: maxFromPlan ?? FREE_MAX_QRS,
    analytics: features[FEAT_ANALYTICS] === true,
    raw: features,
  };
}

export const qrService = {
  async list(relipay: ReliPay, subject: Subject): Promise<QrCode[]> {
    return store.list(scopeOf(subject));
  },

  /**
   * Create a dynamic QR. Enforces the tier's QR-count cap by reading ReliPay
   * entitlements first (402 when the cap is reached).
   */
  async create(
    relipay: ReliPay,
    subject: Subject,
    input: { destination: string; title?: string; slug?: string },
  ): Promise<QrCode> {
    if (!/^https?:\/\//i.test(input.destination)) {
      throw new QrError(400, 'QR_BAD_DESTINATION', 'destination must be an http(s) URL.');
    }
    const { maxQrs } = await resolveEntitlements(relipay, subject);
    const current = store.count(scopeOf(subject));
    if (current >= maxQrs) {
      throw new QrError(
        402,
        'QR_LIMIT_REACHED',
        `Your plan allows ${maxQrs} dynamic QR codes; you have ${current}.`,
        'Upgrade to Pro for more QR codes.',
      );
    }
    let slug = input.slug?.trim() || freshSlug();
    if (store.slugTaken(slug)) {
      if (input.slug) throw new QrError(409, 'QR_SLUG_TAKEN', `Slug "${slug}" is already in use.`);
      // auto-generated collision — retry once
      slug = freshSlug();
    }
    return store.create({
      slug,
      destination: input.destination,
      title: input.title ?? slug,
      ...scopeOf(subject),
    });
  },

  /** Edit a QR's destination (the "dynamic" part). Ownership-checked. */
  async updateDestination(
    relipay: ReliPay,
    subject: Subject,
    qrId: string,
    destination: string,
  ): Promise<QrCode> {
    if (!/^https?:\/\//i.test(destination)) {
      throw new QrError(400, 'QR_BAD_DESTINATION', 'destination must be an http(s) URL.');
    }
    const qr = this.assertOwned(subject, qrId);
    return store.updateDestination(qr.id, destination)!;
  },

  async remove(relipay: ReliPay, subject: Subject, qrId: string): Promise<void> {
    const qr = this.assertOwned(subject, qrId);
    store.remove(qr.id);
  },

  assertOwned(subject: Subject, qrId: string): QrCode {
    const qr = store.byId(qrId);
    const scope = scopeOf(subject);
    const owned = qr && (scope.organizationId
      ? qr.organizationId === scope.organizationId
      : qr.ownerEndUserId === scope.ownerEndUserId && qr.organizationId === null);
    if (!qr || !owned) {
      throw new QrError(404, 'QR_NOT_FOUND', `QR "${qrId}" not found in this workspace.`);
    }
    return qr;
  },

  /**
   * Public scan: record a `qr_scans` usage event in ReliPay, then return the
   * destination to redirect to. ReliPay enforces the monthly scan quota as a
   * hard cap and throws USAGE_QUOTA_EXCEEDED (402) when exhausted — we surface
   * that so the redirect endpoint can return a "quota exceeded" page.
   *
   * The scan is attributed to the QR's subject (org pool if it's a team QR,
   * else the owning end-user) so quota + analytics aggregate correctly.
   */
  async recordScan(relipay: ReliPay, qr: QrCode): Promise<{ destination: string }> {
    await relipay.usage.record({
      meterSlug: METER_QR_SCANS,
      quantity: 1,
      ...(qr.organizationId ? { organizationId: qr.organizationId } : { endUserId: qr.ownerEndUserId }),
      metadata: { slug: qr.slug, qrId: qr.id },
    });
    return { destination: qr.destination };
  },

  /**
   * Analytics for a QR — gated behind the `analytics` feature flag. Reads the
   * scan total from the ReliPay usage aggregate for the QR's subject.
   */
  async analytics(
    relipay: ReliPay,
    subject: Subject,
    qrId: string,
  ): Promise<{ scans: number; since: string }> {
    const { analytics } = await resolveEntitlements(relipay, subject);
    if (!analytics) {
      throw new QrError(
        403,
        'FEATURE_NOT_ENTITLED',
        'Analytics is a Pro feature.',
        'Upgrade to Pro to unlock scan analytics.',
      );
    }
    this.assertOwned(subject, qrId);
    // 30-day window. (Per-QR breakdown would filter on metadata; the public
    // aggregate endpoint sums by subject + meter, which is the tier-level view.)
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const agg = await relipay.usage.aggregate({
      meterSlug: METER_QR_SCANS,
      from: since,
      ...(subject.organizationId ? { organizationId: subject.organizationId } : { endUserId: subject.endUserId }),
    });
    return { scans: agg.total, since };
  },
};
