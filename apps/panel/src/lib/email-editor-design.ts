/**
 * What the Unlayer editor is handed when it becomes ready.
 *
 * The API returns a design for every template: the operator's saved one, or
 * the built-in default as editable blocks. Anything that is not a design
 * document (null from an older API, or a customised row saved without one)
 * leaves the editor on its empty canvas rather than handing Unlayer a value
 * it cannot load.
 */

export interface DesignLoader {
  loadDesign?: (design: unknown) => void;
}

export function isLoadableDesign(design: unknown): design is { body: { rows: unknown[] } } {
  if (typeof design !== 'object' || design === null) return false;
  const body = (design as { body?: unknown }).body;
  if (typeof body !== 'object' || body === null) return false;
  const rows = (body as { rows?: unknown }).rows;
  return Array.isArray(rows) && rows.length > 0;
}

/**
 * Load `design` into the editor when it is a design document.
 *
 * @example
 * hydrateEditor(unlayer, template.designJson); // true when it loaded
 */
export function hydrateEditor(editor: DesignLoader | undefined, design: unknown): boolean {
  if (!editor?.loadDesign || !isLoadableDesign(design)) return false;
  editor.loadDesign(design);
  return true;
}
