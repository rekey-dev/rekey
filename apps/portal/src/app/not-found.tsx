/**
 * Portal 404 — the page a paying customer sees when a portal address doesn't
 * resolve: unknown slug, or an app whose operator hasn't enabled the hosted
 * portal. The API answers both cases identically (existence-hiding), so this
 * page can't tell them apart and deliberately doesn't try.
 *
 * Audience is the merchant's customer, not the operator: no Rekey branding
 * beyond a footer credit, no error codes, and none of the API's operator "fix"
 * hint ("enable the portal in Panel → …") — that text is for the operator.
 *
 * Lives at the app root, not under [slug]: notFound() is thrown by
 * [slug]/layout.tsx itself, so the boundary that catches it has to be the
 * parent segment's. Rendering under the root layout also gives it <html lang>.
 */

import * as React from 'react';
import { Card } from '@/components/card';

export default function NotFound(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md px-5 pt-20 pb-10">
      <Card className="text-center">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">
          This billing portal isn&apos;t available
        </h1>
        <p className="mt-3 text-sm text-[var(--color-muted-fg)]">
          The link you followed doesn&apos;t open a billing portal. Check that you copied the
          whole address, or contact the business you bought from — they can send you a working
          link.
        </p>
      </Card>
      <p className="mt-8 text-center text-xs text-[var(--color-muted-fg)]">Powered by Rekey</p>
    </div>
  );
}
