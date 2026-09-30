'use client';

import * as React from 'react';

/**
 * A native `<select>` that submits its GET form on change. Without JavaScript
 * the form's own Apply button does the same job, so this only saves a click.
 */
export function AutoSubmitSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
