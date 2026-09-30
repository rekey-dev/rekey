/**
 * The Profile fields page's form, read back into the list of fields the API
 * takes. Rows are named by field key (`k_<key>_label`), so a field removed or
 * reordered by someone else cannot shift one row's values onto another; the
 * new-field row is `new_`. Options are one per line, so an option may contain a
 * comma.
 */

type FieldInput = Record<string, unknown>;

function row(formData: FormData, prefix: string, key: string): FieldInput | null {
  const get = (name: string): string => String(formData.get(`${prefix}${name}`) ?? '').trim();
  if (!key || formData.get(`${prefix}remove`) === 'on') return null;
  const type = get('type');
  const options = get('options')
    .split('\n')
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    key,
    label: get('label') || key,
    type,
    ...(type === 'select' ? { options } : {}),
    requiredForOnboarding: formData.get(`${prefix}required`) === 'on',
    writableBy: get('writableBy') === 'server' ? 'server' : 'user',
    showInList: formData.get(`${prefix}showInList`) === 'on',
    pii: formData.get(`${prefix}pii`) === 'on',
  };
}

/**
 * Every kept field in the order the form listed them, then the new one if its
 * key was filled in.
 *
 * @example
 *   await api({ method: 'PUT', path, body: { fields: fieldsFromForm(formData), version } });
 */
export function fieldsFromForm(formData: FormData): FieldInput[] {
  let keys: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(formData.get('keys') ?? '[]'));
    if (Array.isArray(parsed)) keys = parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    keys = [];
  }
  const existing = keys.map((key) => row(formData, `k_${key}_`, key));
  const added = row(formData, 'new_', String(formData.get('new_key') ?? '').trim());
  return [...existing, added].filter((f): f is FieldInput => f !== null);
}

/** Form-control name prefix for an existing field's row. */
export function rowPrefix(key: string): string {
  return `k_${key}_`;
}
