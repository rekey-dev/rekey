import * as React from 'react';
import { Breadcrumb, type Crumb } from '@/components/Breadcrumb';
import { SegmentedNav, type Segment } from '@/components/SegmentedNav';

/**
 * One band for everything a drilled-into record needs to say about itself:
 * where it sits, what it is, and how to switch views of it.
 *
 * ## Why these three things are one component
 *
 * They used to be three: a back link, a `PageHeader`, and a full-width tab
 * strip, each emitted separately and each free to drift. They did drift, the
 * end-user layout overrode `PageHeader`'s `text-xl` back down to `text-lg`
 * inline because the size was wrong for a nested record, the organization,
 * webhook and import-run pages hand-rolled three different versions of the
 * same header, and the two nested tab strips lost the right-edge scroll mask
 * that `AppNav` has.
 *
 * Binding them is also what makes the tier discipline enforceable. A record
 * gets ONE band, and its view switcher is inside that band, so a new nested
 * page cannot accidentally add a fourth full-width strip, because the
 * component it reaches for does not offer one.
 *
 * ## The enclosure
 *
 * The card border is doing real work, not decoration. Above it sit two
 * page-spanning strips that navigate the application; inside it sits
 * everything about one record. The line between them is the only thing that
 * tells you the segmented control below belongs to this user and not to the
 * application, which is exactly what got lost when it was a third strip
 * spanning the same width as the two above it.
 */

export function RecordHeader({
  crumbs,
  title,
  description,
  meta,
  action,
  segments,
  segmentsLabel,
  segmentsFallbackHref,
  children,
}: {
  /**
   * Omitted where the strips above already say where you are. The Email
   * section is the case: AppNav shows Developer active and Email active
   * beneath it, so a trail repeating that would be the third statement of
   * the same fact.
   */
  crumbs?: Crumb[];
  title: React.ReactNode;
  /** Prose. What this section is for, when that is not obvious from the title. */
  description?: React.ReactNode;
  /** Secondary identity line, an id, a slug. Usually mono, always small. */
  meta?: React.ReactNode;
  /** Right-aligned control for the record as a whole (copy link, menu). */
  action?: React.ReactNode;
  /** The record's view switcher. Omit for a record with a single view. */
  segments?: Segment[];
  segmentsLabel?: string;
  /** Which segment claims routes matching none of them, see `SegmentedNav`. */
  segmentsFallbackHref?: string;
  /** Anything that must sit inside the band, below the switcher (rare). */
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="space-y-3 px-4 py-4 sm:px-5">
        {crumbs && crumbs.length > 0 && <Breadcrumb items={crumbs} />}

        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {/* `text-lg`, not PageHeader's `text-xl`. A record title sits under
                the application's own h1 and must not compete with it, the old
                header fought this with an inline override on one page. */}
            <h2 className="flex min-w-0 flex-wrap items-center gap-2 text-lg font-semibold tracking-tight text-[var(--color-fg)]">
              {title}
            </h2>
            {meta && <div className="mt-1 min-w-0 text-xs text-[var(--color-muted-fg)]">{meta}</div>}
            {description && (
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--color-muted-fg)]">
                {description}
              </p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>

        {segments && segments.length > 0 && (
          <SegmentedNav
            segments={segments}
            label={segmentsLabel ?? 'Record sections'}
            {...(segmentsFallbackHref !== undefined && { fallbackHref: segmentsFallbackHref })}
          />
        )}

        {children}
      </div>
    </div>
  );
}
