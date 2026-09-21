'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';

/**
 * Unlayer wrapper. The editor lives in an iframe and exposes
 * `loadDesign` / `exportHtml` via its imperative ref. We don't try to
 * bind it to React state, instead, on submit we ask it for the latest
 * design + html and hand them to the server action ourselves, so the Save
 * button's pending state is ours to clear when the write answers.
 *
 * `designJson` hydrates the editor from a previously-saved template
 * (null for built-in defaults, the editor opens blank). `eventKey` and
 * `applicationId` are pass-through hidden inputs the server action
 * reads back.
 *
 * Variables that the renderer will substitute are surfaced as merge tags
 * in Unlayer's tools, operators see e.g. `{{userEmail}}` chips they can
 * drag into the body.
 */

// react-email-editor's TS types are noisy (heavy generics + forwardRef).
// We re-type as a plain component prop bag, the library is mature enough
// that the shape is stable.
type EditorInstance = {
  loadDesign?: (design: unknown) => void;
  exportHtml?: (cb: (data: { design: unknown; html: string }) => void) => void;
};
type EditorComponentProps = {
  ref?: React.Ref<{ editor?: EditorInstance }>;
  // react-email-editor >=1.7 passes the live unlayer instance as the arg.
  onReady?: (unlayer?: EditorInstance) => void;
  minHeight?: string;
  options?: Record<string, unknown>;
};
// dynamic() with ssr: false keeps the iframe out of the server render tree.
const EmailEditor = dynamic(
  () => import('react-email-editor').then((m) => m.default as unknown as React.ComponentType<EditorComponentProps>),
  { ssr: false },
) as unknown as React.ComponentType<EditorComponentProps>;

export interface EmailEditorClientProps {
  applicationId: string;
  eventKey: string;
  initialSubject: string;
  /** Saved Unlayer design (null when only the built-in default exists). */
  initialDesignJson: unknown | null;
  /** Server-action handle, receives FormData with subject, designJson, bodyHtml. */
  action: (formData: FormData) => Promise<void>;
  /** Variable names registered for this event, e.g. ['userEmail','resetUrl']. */
  variables: ReadonlyArray<string>;
}

export function EmailEditorClient(props: EmailEditorClientProps): React.JSX.Element {
  const editorRef = React.useRef<{ editor?: EditorInstance } | null>(null);
  const [subject, setSubject] = React.useState(props.initialSubject);
  const [designJsonHidden, setDesignJsonHidden] = React.useState<string>('');
  const [bodyHtmlHidden, setBodyHtmlHidden] = React.useState<string>('');
  const [submitting, setSubmitting] = React.useState(false);
  const [, startTransition] = React.useTransition();
  const [ready, setReady] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  const exportTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Never leave a pending export timeout behind after unmount.
  React.useEffect(
    () => () => {
      if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
    },
    [],
  );

  // Hydrate the editor from saved design once it's ready.
  //
  // react-email-editor >=1.7 hands the live unlayer instance to `onReady` as
  // an argument; older versions exposed it via `ref.current.editor`. Reading
  // only the ref raced the iframe init and left the builder blank on edit even
  // though the saved design existed. Prefer the arg, fall back to the ref.
  const onReady = React.useCallback(
    (unlayer?: EditorInstance) => {
      const editor = unlayer ?? editorRef.current?.editor;
      if (props.initialDesignJson && editor?.loadDesign) {
        editor.loadDesign(props.initialDesignJson);
      }
      // Unlock Save, before this fires, exportHtml would silently no-op.
      setReady(true);
    },
    [props.initialDesignJson],
  );

  // Merge-tags surface the registered variables in the Unlayer UI.
  const mergeTags = React.useMemo(() => {
    const out: Record<string, { name: string; value: string }> = {};
    for (const v of props.variables) {
      out[v] = { name: v, value: `{{${v}}}` };
    }
    return out;
  }, [props.variables]);

  const EXPORT_TIMEOUT_MS = 15_000;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    setSaveError(null);
    const editor = editorRef.current?.editor;
    if (!editor?.exportHtml) {
      setSaveError('The editor is still loading. Wait a moment and try again.');
      return;
    }
    setSubmitting(true);
    // exportHtml's callback can simply never fire (iframe wedged, editor torn
    // down). Without a deadline that leaves the button stuck on "Saving…"
    // forever, so time out, re-enable Save, and surface an error instead.
    let settled = false;
    exportTimeoutRef.current = setTimeout(() => {
      if (settled) return;
      settled = true;
      setSubmitting(false);
      setSaveError('The editor did not respond in time. Try saving again. If it keeps failing, reload the page.');
    }, EXPORT_TIMEOUT_MS);
    editor.exportHtml((data) => {
      if (settled) return; // timed out, don't submit a stale export
      settled = true;
      if (exportTimeoutRef.current) clearTimeout(exportTimeoutRef.current);
      const designJson = JSON.stringify(data.design);
      // Still mirrored into the hidden inputs: they are what a browser with
      // no JavaScript would post, and what the next export overwrites.
      setDesignJsonHidden(designJson);
      setBodyHtmlHidden(data.html);
      // Build the FormData here rather than waiting a tick for React to
      // commit those two inputs and then `requestSubmit()`ing. That older
      // path went through the form's `action` directly, which meant nothing
      // was left holding the save: `submitting` was set before the export and
      // never cleared again, so the button stayed on "Saving…" and disabled
      // until a navigation happened to remount the editor. Owning the call
      // lets us clear it when the write answers, exactly as `ActionForm`
      // does for the panel's other forms. The action runs inside a transition
      // so the router has one to navigate with, and the chain that clears the
      // flag is left outside it because an action ending in `redirect()` puts
      // the navigation into that transition, and the navigation is the part
      // that can hang.
      const form = formRef.current;
      if (!form) {
        setSubmitting(false);
        return;
      }
      const formData = new FormData(form);
      formData.set('designJson', designJson);
      formData.set('bodyHtml', data.html);
      startTransition(() => {
        void Promise.resolve(props.action(formData)).finally(() => {
          setSubmitting(false);
        });
      });
    });
  }

  return (
    <form
      ref={formRef}
      action={props.action}
      // Always ours. The old conditional handed the second submit straight to
      // the form's `action`, which is the path that never settled.
      onSubmit={handleSubmit}
    >
      <input type="hidden" name="applicationId" value={props.applicationId} />
      <input type="hidden" name="eventKey" value={props.eventKey} />
      <input type="hidden" name="designJson" value={designJsonHidden} />
      <input type="hidden" name="bodyHtml" value={bodyHtmlHidden} />

      {/* Compact toolbar sub-header: subject + variables + save, all on one
          row so the builder gets the vertical space. Sticky so Save stays
          reachable while scrolling the editor. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-t-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-2">
        <div className="flex flex-1 min-w-[14rem] items-center gap-2">
          <label htmlFor="email-subject" className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-muted-fg)] shrink-0">
            Subject
          </label>
          <input
            id="email-subject"
            type="text"
            name="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            maxLength={998}
            placeholder="Welcome to {{appName}}"
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_30%,transparent)] focus:border-[var(--color-primary)]"
          />
        </div>

        {props.variables.length > 0 && (
          <details className="relative text-xs">
            <summary className="cursor-pointer list-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[var(--color-muted-fg)] hover:text-[var(--color-fg)] select-none">
              Variables ({props.variables.length})
            </summary>
            <div className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg">
              <p className="mb-1.5 text-[11px] text-[var(--color-muted-fg)]">
                Drag the merge-tag chips in the editor toolbar into the body. Values are HTML-escaped at send time.
              </p>
              <div className="flex flex-wrap gap-1">
                {props.variables.map((v) => (
                  <code key={v} className="rounded bg-[var(--color-surface-muted)] px-1.5 py-0.5 font-mono text-[11px]">
                    {`{{${v}}}`}
                  </code>
                ))}
              </div>
            </div>
          </details>
        )}

        <button
          type="submit"
          disabled={!ready || submitting}
          aria-busy={submitting || undefined}
          className="rounded-md bg-[var(--color-primary)] px-3.5 py-1.5 text-sm font-medium text-[var(--color-primary-fg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 shrink-0"
        >
          {!ready ? 'Loading editor…' : submitting ? 'Saving…' : 'Save'}
        </button>

        {saveError && (
          <p role="alert" className="w-full text-xs text-red-600 dark:text-red-400">
            {saveError}
          </p>
        )}
      </div>

      <div className="rounded-b-md border border-t-0 border-[var(--color-border)] overflow-hidden" style={{ height: 600 }}>
        <EmailEditor
          ref={editorRef}
          onReady={onReady}
          minHeight="600px"
          options={{
            mergeTags,
            features: { textEditor: { tables: true } },
            appearance: { theme: 'modern_light' },
          }}
        />
      </div>
    </form>
  );
}
