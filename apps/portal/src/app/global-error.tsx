'use client';

/**
 * Last-resort boundary: the ROOT LAYOUT itself failed, so Next has thrown away
 * the whole tree including `<html>`/`<body>`. This file has to supply them.
 *
 * Deliberately inline-styled and import-free. `global-error.tsx` replaces the
 * root layout, which means the stylesheet that layout imports is not applied —
 * a Tailwind-classed version of this page renders as unstyled text in exactly
 * the situation it exists for. Anything this page imports is also one more
 * thing that can be the reason the page is broken. So: no CSS import, no
 * component library, no icons. Plain elements and a style attribute.
 *
 * Same audience as the rest of the portal — the merchant's customer — so the
 * copy carries no error code, no digest, and no operator instruction.
 */

import * as React from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '2rem 1.25rem',
          background: '#fafafa',
          color: '#18181b',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ maxWidth: '26rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>
            This page didn&apos;t load
          </h1>
          <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#52525b', lineHeight: 1.6 }}>
            Something went wrong on our side, not yours. Nothing has been charged or changed.
            Try again in a moment — if it keeps happening, contact the business you bought from.
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: '1.25rem',
              border: 0,
              borderRadius: '0.375rem',
              padding: '0.5rem 1rem',
              fontSize: '0.875rem',
              fontWeight: 500,
              color: '#ffffff',
              background: '#18181b',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
