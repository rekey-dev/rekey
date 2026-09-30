/**
 * A React `key` for a form that changes whenever the saved values it was
 * rendered from change, so the form remounts with fresh defaults after a save.
 *
 * React 19 resets a form after its action runs, back to each field's default.
 * Inputs, textareas, checkboxes and radios pick up a new `defaultValue` or
 * `defaultChecked` from the re-render, but a `<select>` only applies
 * `defaultValue` when it mounts. Without a remount the select snaps back to
 * the value from before the save, and the next save writes that stale value
 * back to the API.
 *
 * The JSON itself rather than a hash of it, so two different saved states can
 * never share a key.
 *
 * @example
 * <ActionForm key={savedStateKey(app.authConfig)} action={save}>…</ActionForm>
 */
export function savedStateKey(saved: unknown): string {
  return JSON.stringify(saved) ?? '';
}
