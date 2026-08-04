'use client';

/**
 * Last-resort boundary: the panel's ROOT LAYOUT threw, so Next discarded the
 * whole tree — `<html>` and `<body>` included, which this file must supply.
 *
 * Inline-styled and import-free on purpose. `global-error.tsx` replaces the
 * root layout, so the stylesheet that layout imports is NOT applied: a
 * Tailwind-classed version of this page renders as unstyled text in precisely
 * the situation it exists for. Every import here is also one more thing that
 * could be the reason the page is broken.
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
        <div style={{ maxWidth: '28rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: 0 }}>
            The panel failed to start
          </h1>
          <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', color: '#52525b', lineHeight: 1.6 }}>
            An unrecoverable error occurred before the page could render. Reloading usually
            clears a transient fault. If it persists, check the panel deployment&apos;s logs and
            that <code>REKEY_URL</code> points at a reachable API.
            {error.digest ? ` (ref ${error.digest})` : ''}
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
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
