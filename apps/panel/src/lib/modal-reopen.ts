/**
 * The reopen-on-error contract between a server action and a `<Modal>`.
 *
 * A modal-hosted form submits to a server action. On failure the action
 * `redirect()`s back with `?error=<code>` plus a flag naming which modal to
 * reopen, and `<Modal modalKey=…>` reopens itself when it sees that flag.
 *
 * Getting the flag wrong is silent: the modal stays shut, and because the error
 * is rendered INSIDE the dialog, a closed `<dialog>` renders nothing. The
 * operator gets a full page navigation, an unchanged row, and no message —
 * which is what `?editUser=<id>` paired with `modalKey={`editUser_${id}`}` did
 * to every failed end-user edit and role delete.
 *
 * Both halves live here so the flag a page redirects with and the flag its
 * modal waits for cannot drift apart.
 */

/** Reads like `URLSearchParams`; also satisfied by Next's `ReadonlyURLSearchParams`. */
export interface FlagSource {
  get(name: string): string | null;
}

/**
 * The value a modal's flag must hold for THAT modal to reopen.
 *
 * `'1'` for a page with one modal of its kind; the row id for a page rendering
 * one modal per row, so only the row that actually failed reopens.
 */
export function modalFlagValue(modalValue?: string): string {
  return modalValue ?? '1';
}

/** The `key=value` fragment a server action appends to its failure redirect. */
export function modalFlag(modalKey: string, modalValue?: string): string {
  return `${encodeURIComponent(modalKey)}=${encodeURIComponent(modalFlagValue(modalValue))}`;
}

/** Whether the current querystring asks this particular modal to reopen. */
export function shouldReopen(
  params: FlagSource,
  modalKey: string | undefined,
  modalValue?: string,
): boolean {
  if (!modalKey) return false;
  return params.get(modalKey) === modalFlagValue(modalValue);
}
