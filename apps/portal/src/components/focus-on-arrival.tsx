'use client';

/**
 * Moves keyboard and screen reader focus to its content when the page
 * arrives with it, so a message a form came back with is read first.
 */

import * as React from 'react';

export function FocusOnArrival({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className="outline-none">
      {children}
    </div>
  );
}
