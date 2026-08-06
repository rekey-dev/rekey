/**
 * The text inside an error banner, when the failure came from the API.
 *
 * The panel used to keep a per-page `ERR` map of code → sentence and fall back
 * to "Something went wrong. Please try again." for anything unmapped. That
 * threw away an answer the API had already given precisely — a workspace at its
 * application limit says which limit, what the current count is, and which
 * environments are exempt — and replaced it with a sentence carrying no
 * information at all. Every limit or policy added to the API arrived in the
 * panel as a shrug.
 *
 * Order of preference:
 *   1. the page's own words, where it has better ones for that code
 *   2. the API's message, carried through the redirect by `errorQuery`
 *   3. the generic sentence, which now only appears when there is genuinely
 *      nothing to say
 *
 * The API's `fix` is shown only in case 2: where the page supplied its own
 * wording, it owns the whole message and a second sentence from elsewhere would
 * read as a non-sequitur.
 *
 * `detail` and `fix` come from `readErrorFlash`, which reads an httpOnly
 * cookie the panel itself wrote — not from the query string, where anyone
 * composing a link could have written them and had arbitrary text rendered
 * inside this banner. React escapes them either way, but escaping was never
 * the exposure here; provenance was.
 */
export function ApiErrorText({
  code,
  detail,
  fix,
  map,
  fallback = 'Something went wrong. Please try again.',
}: {
  code: string | undefined;
  detail?: string | undefined;
  fix?: string | undefined;
  map?: Record<string, string>;
  fallback?: string;
}) {
  const mapped = code ? map?.[code] : undefined;
  const text = mapped ?? detail ?? fallback;

  return (
    <>
      {text}
      {mapped === undefined && fix ? (
        <span className="mt-1 block text-sm opacity-90">{fix}</span>
      ) : null}
    </>
  );
}
