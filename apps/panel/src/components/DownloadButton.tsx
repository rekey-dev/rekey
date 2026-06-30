'use client';

/**
 * Download a string as a text file. Used for "save your backup codes"
 * and similar one-time-show flows.
 */

import * as React from 'react';

export function DownloadButton({
  filename,
  content,
  label = 'Download',
}: {
  filename: string;
  content: string;
  label?: string;
}): React.JSX.Element {
  function download(): void {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      onClick={download}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-neutral-50 dark:hover:bg-neutral-800 px-2 py-1 text-xs font-medium"
    >
      <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM10 2a1 1 0 011 1v9.6l3.3-3.3a1 1 0 011.4 1.4l-5 5a1 1 0 01-1.4 0l-5-5a1 1 0 111.4-1.4L9 12.6V3a1 1 0 011-1z" clipRule="evenodd" />
      </svg>
      {label}
    </button>
  );
}
