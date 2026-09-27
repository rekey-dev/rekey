import { describe, it, expect, vi } from 'vitest';
import { hydrateEditor, isLoadableDesign } from '@/lib/email-editor-design';

/**
 * A template with no saved customisation used to open the editor on an empty
 * canvas while the preview below it showed the default, so tweaking one line
 * meant rebuilding the mail. The API now sends the default as a design; this
 * is the panel's half: whatever design arrives is what the editor loads.
 */

const defaultDesign = {
  counters: { u_row: 2 },
  body: { id: 'u_body', rows: [{ id: 'u_row_1' }, { id: 'u_row_2' }], headers: [], footers: [], values: {} },
  schemaVersion: 16,
};

describe('hydrateEditor', () => {
  it('loads the default design an uncustomised template arrives with', () => {
    const loadDesign = vi.fn();
    expect(hydrateEditor({ loadDesign }, defaultDesign)).toBe(true);
    expect(loadDesign).toHaveBeenCalledWith(defaultDesign);
  });

  it('loads a saved design the same way', () => {
    const loadDesign = vi.fn();
    const saved = { body: { rows: [{ id: 'mine' }] } };
    hydrateEditor({ loadDesign }, saved);
    expect(loadDesign).toHaveBeenCalledWith(saved);
  });

  it.each([null, undefined, {}, { body: {} }, { body: { rows: [] } }, 'design'])(
    'leaves the editor alone for %j',
    (design) => {
      const loadDesign = vi.fn();
      expect(hydrateEditor({ loadDesign }, design)).toBe(false);
      expect(loadDesign).not.toHaveBeenCalled();
    },
  );

  it('does nothing before the editor instance exists', () => {
    expect(hydrateEditor(undefined, defaultDesign)).toBe(false);
  });
});

describe('isLoadableDesign', () => {
  it('needs at least one row', () => {
    expect(isLoadableDesign(defaultDesign)).toBe(true);
    expect(isLoadableDesign({ body: { rows: [] } })).toBe(false);
  });
});
