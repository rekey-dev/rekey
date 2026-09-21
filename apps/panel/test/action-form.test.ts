/**
 * Guard: nothing in the panel reads React's form pending state directly, and
 * every form that pairs a server action with a pending-aware control goes
 * through `ActionForm`.
 *
 * `useFormStatus().pending` stays `true` forever when the action resolves
 * very quickly (rekey issue #567, upstream vercel/next.js#53966). The button
 * keeps its "Saving…" label and stays disabled although the write succeeded,
 * and a stuck `aria-busy="true"` also blocks `RefreshAfterAction`, which
 * waits for every busy control to settle. It only reproduces on a production
 * build, so a browser test of it would be flaky and a typecheck will never
 * see it. This is a source scan instead: it cannot be reintroduced without
 * turning this red.
 *
 * The form-level check reads one file at a time, so it used to pair a form
 * with a button only when both were written in the same place. `AuthCard`
 * shipped green that way: the form was in the component and every caller put
 * its own `SubmitButton` in the slot. The check now also follows local
 * wrapper components and treats a form around `{children}` as holding
 * whatever the caller puts there. Its own docblock says what it still cannot
 * see.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

/**
 * The only file allowed to reach for `useFormStatus`. `ActionForm` owns the
 * fallback: `useActionPending()` returns the enclosing `ActionForm`'s flag
 * when there is one and React's otherwise, so a form that has not been
 * converted keeps behaving as it did. Any other entry here needs a reason
 * written next to it.
 */
const FORM_STATUS_ALLOWLIST = [path.join('components', 'ActionForm.tsx')];

/** Controls whose pending or busy state comes from `useActionPending`. */
const PENDING_AWARE = ['<SubmitButton', '<StickyFormFooter', '<ConfirmButton', '<TypedConfirmButton'];

/**
 * Files allowed to render a plain `<form action={…}>` around a slot they do
 * not control (`{children}` and friends). `ActionForm` is the implementation
 * of the rule, so it is the one file that cannot obey it. Anything else here
 * needs a reason written next to it.
 */
const OPEN_FORM_ALLOWLIST = [path.join('components', 'ActionForm.tsx')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * Blank every `/* … *\/` comment, keeping offsets and line numbers, so a
 * docblock example of the old shape is not mistaken for real JSX.
 */
export function blankBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Spans of every non-self-closing `<form …>…</form>` in a source file, as
 * `{ head, body, line }`. The opening tag ends at the first `>` that is not
 * inside a JSX expression container, so `action={x.bind(null, y)}` and
 * `className={cx({ a: b })}` do not cut it short.
 */
export function formElements(source: string): { head: string; body: string; line: number }[] {
  const text = blankBlockComments(source);
  const found: { head: string; body: string; line: number }[] = [];
  for (const match of text.matchAll(/<form\b/g)) {
    const start = match.index;
    let i = start + match[0].length;
    let depth = 0;
    for (; i < text.length; i += 1) {
      const c = text[i];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '>' && depth === 0) break;
    }
    if (i >= text.length) continue;
    if (text[i - 1] === '/') continue;
    const close = text.indexOf('</form>', i);
    if (close < 0) continue;
    found.push({
      head: text.slice(start, i + 1),
      body: text.slice(i + 1, close),
      line: text.slice(0, start).split('\n').length,
    });
  }
  return found;
}

/**
 * Rough top-level component spans of a file, as `{ name, body }`. A span runs
 * from one capitalised `function Foo` / `const Foo =` declaration to the next,
 * which is close enough: it only has to say which JSX a component renders.
 */
export function componentBodies(source: string): { name: string; body: string }[] {
  const text = blankBlockComments(source);
  const decl =
    /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Z]\w*)|(?:^|\n)\s*(?:export\s+)?(?:const|let)\s+([A-Z]\w*)\s*(?::[^=\n]*)?=/g;
  const marks: { name: string; start: number }[] = [];
  for (const m of text.matchAll(decl)) {
    marks.push({ name: (m[1] ?? m[2])!, start: m.index });
  }
  return marks.map((mark, i) => ({
    name: mark.name,
    body: text.slice(mark.start, marks[i + 1]?.start ?? text.length),
  }));
}

/**
 * Every tag that carries a pending-aware control, the four named ones plus
 * every local component that renders one of them, transitively. `OAuthButton`
 * on the login page is a `SubmitButton` under another name, and the form
 * around it has exactly the same bug as a form around a `SubmitButton`.
 */
export function pendingAwareTags(sources: string[]): Set<string> {
  const tags = new Set(PENDING_AWARE);
  for (let pass = 0; pass < 10; pass += 1) {
    let grew = false;
    for (const source of sources) {
      for (const { name, body } of componentBodies(source)) {
        const tag = `<${name}`;
        if (tags.has(tag)) continue;
        if ([...tags].some((t) => body.includes(t))) {
          tags.add(tag);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return tags;
}

/**
 * True when a form's body renders a slot its own file does not control: the
 * submit control then arrives from whichever caller fills it, and no scan of
 * this file can know whether it is pending-aware. `AuthCard` was exactly this
 * shape, and its four callers each put a `SubmitButton` in the slot.
 */
export function rendersUncontrolledSlot(body: string): boolean {
  return /\{\s*(?:props\.)?children\s*\}/.test(body);
}

/** True when a source file imports `useFormStatus` from `react-dom`. */
export function importsUseFormStatus(source: string): boolean {
  const text = blankBlockComments(source);
  const from = String.raw`\s*['"]react-dom['"]`;
  for (const m of text.matchAll(new RegExp(String.raw`\bimport\s+([^;]*?)\s+from` + from, 'g'))) {
    const clause = (m[1] ?? '').trim();
    const named = /\{([^}]*)\}/.exec(clause);
    if (!named) continue; // default or namespace import, checked below
    if (named[1]!.split(',').some((n) => n.trim().replace(/^type\s+/, '') === 'useFormStatus')) {
      return true;
    }
  }
  // A namespace or require grab, plus a property read, reaches it too.
  if (/\buseFormStatus\b/.test(text) && new RegExp(String.raw`\brequire\s*\(` + from).test(text)) {
    return true;
  }
  return false;
}

describe('action forms own their pending state', () => {
  it('only ActionForm reads useFormStatus', () => {
    const allowed = new Set(FORM_STATUS_ALLOWLIST.map((p) => path.join(srcDir, p)));
    const offenders = sourceFiles(srcDir).filter(
      (f) => !allowed.has(f) && importsUseFormStatus(readFileSync(f, 'utf8')),
    );
    expect(
      offenders.map((f) => path.relative(srcDir, f)),
      "useFormStatus().pending can stick forever on a production build (issue #567). Read useActionPending() from @/components/ActionForm instead, which falls back to useFormStatus when there is no ActionForm above it. If a file genuinely needs the raw hook, add it to FORM_STATUS_ALLOWLIST with a reason.",
    ).toEqual([]);
  });

  /**
   * What this check can and cannot see.
   *
   * It sees a pending-aware control written in the same file as the form, one
   * reached through a local wrapper component (`OAuthButton` renders a
   * `SubmitButton`), and a form that hands a slot to its callers, which is the
   * cross-file case: the file holding the form and the file holding the button
   * are scanned separately and nothing pairs them, so a form around
   * `{children}` is treated as if the worst caller had filled it. That is the
   * shape `AuthCard` shipped in, green, under the first version of this test.
   *
   * It does not see: a control handed in as an element-valued prop rather than
   * as children (`footer={<SubmitButton />}`), a tag chosen at runtime or
   * built with `React.createElement`, a component whose declaration this
   * file's rough span splitter mis-attributes (a component declared inside
   * another function body counts towards its parent), or a `<form>` element
   * that is itself produced by something else. A perfect answer would need a
   * real type-aware pass over the render tree, which is more machinery than
   * the rule is worth. If you are adding one of those shapes, use
   * `ActionForm`: nothing here will stop you otherwise.
   */
  it('no <form action={…}> can hold a pending-aware control, directly or through a slot', () => {
    const files = sourceFiles(srcDir);
    const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
    const tags = pendingAwareTags([...sources.values()]);
    const exempt = new Set(OPEN_FORM_ALLOWLIST.map((p) => path.join(srcDir, p)));
    const offenders: string[] = [];
    for (const file of files) {
      if (exempt.has(file)) continue;
      for (const form of formElements(sources.get(file)!)) {
        if (!form.head.includes('action=')) continue;
        const holds = [...tags].some((tag) => form.body.includes(tag));
        const slot = rendersUncontrolledSlot(form.body);
        if (!holds && !slot) continue;
        offenders.push(`${path.relative(srcDir, file)}:${form.line}${slot && !holds ? ' (slot)' : ''}`);
      }
    }
    expect(
      offenders,
      'These forms hold a control whose pending state can stick forever on a production build (issue #567), or hand a slot to a caller that can put one there, but they are a plain <form action={…}>. Use <ActionForm> from @/components/ActionForm instead.',
    ).toEqual([]);
  });

  it('SubmitButton and the confirm buttons read useActionPending', () => {
    for (const name of [
      'SubmitButton.tsx',
      'StickyFormFooter.tsx',
      'ConfirmButton.tsx',
      'TypedConfirmButton.tsx',
    ]) {
      const source = readFileSync(path.join(srcDir, 'components', name), 'utf8');
      expect(source, name).toContain('useActionPending');
    }
  });

  /**
   * This used to read `<form action={action}>` plus `useTransition`, for the
   * no-JavaScript path: with the server-action reference on the element, React
   * emits the URL and the `$ACTION_ID` fields that let a browser with scripts
   * off post the form natively.
   *
   * That shape is what dropped the redirect (issue #569), because the same
   * component then cancelled the submit and called the action itself, outside
   * the transition React opens for a dispatch it owns. `ActionForm` now hands
   * the submit to React and wraps the action instead, which costs the native
   * post. The no-JavaScript path was already only nominally there, and a save
   * that lands and shows nothing is the worse of the two failures.
   *
   * `test/action-form-dispatch.test.ts` is the behavioural half of this.
   */
  it('ActionForm does not cancel the submit and call the action itself', () => {
    const source = readFileSync(path.join(srcDir, 'components', 'ActionForm.tsx'), 'utf8');
    const body = blankBlockComments(source).slice(source.indexOf('export function ActionForm'));
    expect(
      body,
      'A preventDefault() in the submit handler that ActionForm itself decides on takes the submit away from React (issue #569). The only preventDefault allowed here is a caller\'s own, read through event.defaultPrevented.',
    ).not.toMatch(/event\.preventDefault\(\)/);
    expect(body, 'a caller must still be able to cancel').toContain('event.defaultPrevented');
  });

  it('the scanners see through expression containers, comments and self-closing tags', () => {
    const cases: [string, number][] = [
      ['<form action={a}><SubmitButton /></form>', 1],
      ['<form action={a}><ConfirmButton confirm="x">Go</ConfirmButton></form>', 1],
      ['<form action={a}><StickyFormFooter /></form>', 1],
      ['<form action={a.bind(null, b)} className={cx({ x: y })}><SubmitButton /></form>', 1],
      ['<form\n  action={a}\n>\n  <SubmitButton />\n</form>', 1],
      ['/** <form action={a}><SubmitButton /></form> */', 0],
      ['<form action="/x" />', 0],
      ['<form action={a}><input name="q" /></form>', 0],
      ['<ActionForm action={a}><SubmitButton /></ActionForm>', 0],
    ];
    for (const [source, expected] of cases) {
      const hits = formElements(source).filter(
        (f) => f.head.includes('action=') && PENDING_AWARE.some((t) => f.body.includes(t)),
      );
      expect(hits.length, source).toBe(expected);
    }

    // A control reached through a local wrapper, and a slot the caller fills.
    const wrapper = [
      'function OAuthButton(): React.JSX.Element {',
      '  return <SubmitButton pendingLabel="Redirecting…">Go</SubmitButton>;',
      '}',
      'export const Quiet = () => <span />;',
    ].join('\n');
    const tags = pendingAwareTags([wrapper]);
    expect(tags.has('<OAuthButton')).toBe(true);
    expect(tags.has('<Quiet')).toBe(false);
    expect(
      formElements('<form action={a}><OAuthButton provider="google" /></form>').some((f) =>
        [...tags].some((t) => f.body.includes(t)),
      ),
    ).toBe(true);

    for (const yes of ['<div>{children}</div>', '<div>{ props.children }</div>']) {
      expect(rendersUncontrolledSlot(yes), yes).toBe(true);
    }
    for (const no of ['<div>{header}</div>', '<div>{rows.map(r => r)}</div>', 'childrenCount']) {
      expect(rendersUncontrolledSlot(no), no).toBe(false);
    }

    for (const yes of [
      "import { useFormStatus } from 'react-dom';",
      'import { flushSync, useFormStatus } from "react-dom";',
      "import { type useFormStatus } from 'react-dom';",
    ]) {
      expect(importsUseFormStatus(yes), yes).toBe(true);
    }
    for (const no of [
      "import { useFormState } from 'react-dom';",
      "/** mentions useFormStatus in prose */\nimport { flushSync } from 'react-dom';",
      "import { useActionPending } from './ActionForm';",
    ]) {
      expect(importsUseFormStatus(no), no).toBe(false);
    }
  });
});
