'use client';

import * as React from 'react';

/**
 * A `<select>` inside a GET filter form that applies itself. Without
 * JavaScript it is an ordinary field and the form's Enter-to-submit still
 * works.
 */
export function SubmitOnChangeSelect(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
): React.JSX.Element {
  return <select {...props} onChange={(e) => e.currentTarget.form?.requestSubmit()} />;
}
