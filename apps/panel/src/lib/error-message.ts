/**
 * The sentence an error banner shows for a code that arrived in the URL.
 *
 * Pages redirect failures back to themselves as `?error=<code>` (or a sibling
 * param) and look the code up in their own message map. The old fallback was
 * the code itself, so `?error=Your+account+is+suspended.+Call+...` rendered
 * that sentence inside a real error banner on the real panel host. React
 * escaped it, but escaping was never the problem: anyone composing a link
 * chose the words.
 *
 * A code the page has copy for renders that copy, exactly as before. Anything
 * else renders a fixed sentence, never the value from the URL. Own properties
 * only, so `?error=constructor` cannot reach `Object.prototype`.
 */
export const GENERIC_ERROR_MESSAGE =
  'Something went wrong. Try again, or contact support if it keeps happening.';

export function errorMessage(
  messages: Readonly<Record<string, string>>,
  code: string,
): string {
  return Object.prototype.hasOwnProperty.call(messages, code)
    ? (messages[code] as string)
    : GENERIC_ERROR_MESSAGE;
}
