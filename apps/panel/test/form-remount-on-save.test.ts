/**
 * Guard: a server-action form whose `<select>` takes its default from saved
 * server state remounts when that state changes.
 *
 * React 19 resets a form after its action runs. Inputs, textareas, checkboxes
 * and radios take their new `defaultValue` / `defaultChecked` from the
 * re-render, but a `<select>` applies `defaultValue` only when it mounts. So on
 * the Auth methods page, saving "Welcome email: After email verification"
 * stored `on_verified` and the select snapped back to "On sign-up" until a
 * full reload, and the next save wrote `on_signup` back. The fix is a `key`
 * from `savedStateKey(...)` on the `ActionForm`, which this pins.
 *
 * A source scan, like `action-form.test.ts`: the failure needs a real browser,
 * a server action and a redirect, and a scan cannot be skipped by a refactor.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { savedStateKey } from '../src/lib/saved-state-key';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

/** Components that render a select with a non-literal default inside their caller's form. */
const SELECT_WRAPPERS = ['MemberRoleSelect'];

/**
 * Selects exempt from the rule, as `file: defaultValue expression`, each with
 * the reason it cannot go stale.
 */
const ALLOWED: Record<string, string> = {
  // A constant per row: nothing a save returns can change it.
  "app/(authed)/applications/[id]/end-users/[euid]/subscriptions/page.tsx: i === 0 ? 'FEATURE' : ''":
    'constant',
  // A create form. After a create the reset back to the catalog default is
  // what an operator wants, and nothing this form saves changes the default.
  'app/(authed)/applications/[id]/end-users/page.tsx: defaultRoleName': 'create form',
  // Rendered inside the caller's ActionForm, which team/page.tsx keys on m.role.
  'components/MemberRoleSelect.tsx: currentRole': 'keyed by caller',
  // AnswerInput renders inside the edit dialog's ActionForm, keyed on the saved answers.
  'app/(authed)/applications/[id]/end-users/[euid]/overview-answers.tsx: value': 'keyed by caller',
  // FieldRow renders inside the page's one ActionForm, keyed on the saved fields.
  "app/(authed)/applications/[id]/onboarding/questions-form.tsx: field?.type ?? 'text'": 'keyed by caller',
  "app/(authed)/applications/[id]/onboarding/questions-form.tsx: field?.writableBy ?? 'user'": 'keyed by caller',
  // SelectField renders inside the Users overview's filter form, a GET form: submitting it loads a fresh page.
  "app/(authed)/applications/[id]/users/filter-bar.tsx: value ?? ''": 'GET form',
};

/** Blank `/* … *\/` comments, keeping offsets, so a docblock is not read as JSX. */
function blankBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

/** End of the opening tag that starts at `start`, skipping `>` inside `{…}`. */
function tagEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return i;
  }
  return text.length;
}

/** The `defaultValue={…}` expression of an opening tag, or null for a literal or none. */
function dynamicDefault(tag: string): string | null {
  const at = tag.search(/\bdefaultValue=\{/);
  if (at < 0) return null;
  const open = tag.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < tag.length; i += 1) {
    if (tag[i] === '{') depth += 1;
    else if (tag[i] === '}') {
      depth -= 1;
      if (depth === 0) return tag.slice(open + 1, i).trim();
    }
  }
  return null;
}

/** The opening tag of the innermost `<ActionForm>` or `<form>` still open at `pos`. */
function enclosingForm(text: string, pos: number): string | null {
  const stack: number[] = [];
  for (const m of text.slice(0, pos).matchAll(/<(\/?)(ActionForm|form)\b/g)) {
    if (m[1] === '/') stack.pop();
    else {
      const end = tagEnd(text, m.index);
      if (text[end - 1] !== '/') stack.push(m.index);
    }
  }
  const start = stack.at(-1);
  return start === undefined ? null : text.slice(start, tagEnd(text, start) + 1);
}

export interface StaleSelect {
  where: string;
  expr: string;
  form: string | null;
}

/** Every select with a server-derived default whose form will not remount on save. */
export function staleSelects(file: string, source: string): StaleSelect[] {
  const text = blankBlockComments(source);
  const tags = new RegExp(`<(select|${SELECT_WRAPPERS.join('|')})\\b`, 'g');
  const found: StaleSelect[] = [];
  for (const m of text.matchAll(tags)) {
    const tag = text.slice(m.index, tagEnd(text, m.index) + 1);
    const isWrapper = m[1] !== 'select';
    const expr = isWrapper ? `<${m[1]}>` : dynamicDefault(tag);
    if (expr === null) continue;
    if (ALLOWED[`${file}: ${expr}`]) continue;
    const form = enclosingForm(text, m.index);
    // A plain `<form>` with no action is a GET form: submitting it is a full
    // page load, which mounts everything fresh.
    if (form?.startsWith('<form') && !/\baction=/.test(form)) continue;
    if (form && /\bkey=\{\s*savedStateKey\(/.test(form)) continue;
    found.push({ where: `${file}:${text.slice(0, m.index).split('\n').length}`, expr, form });
  }
  return found;
}

describe('forms remount on saved state', () => {
  it('keys every action form whose select defaults come from the server', () => {
    const offenders = sourceFiles(srcDir).flatMap((f) =>
      staleSelects(path.relative(srcDir, f).split(path.sep).join('/'), readFileSync(f, 'utf8')),
    );
    expect(
      offenders.map((o) => `${o.where} ${o.expr}`),
      'A <select defaultValue> keeps its pre-save value after React resets the form. Put key={savedStateKey(<the saved values the form renders>)} on the enclosing ActionForm, or add the select to ALLOWED with the reason it cannot go stale.',
    ).toEqual([]);
  });

  it('flags an unkeyed action form and passes a keyed one', () => {
    const unkeyed = `<ActionForm action={save}><select name="mfa" defaultValue={mfa} /></ActionForm>`;
    const keyed = `<ActionForm key={savedStateKey(cfg)} action={save}><select name="mfa" defaultValue={mfa} /></ActionForm>`;
    const literal = `<ActionForm action={save}><select name="mfa" defaultValue="off" /></ActionForm>`;
    const getForm = `<form className="x"><select name="status" defaultValue={status} /></form>`;
    const wrapper = `<ActionForm action={save}><MemberRoleSelect currentRole={m.role} /></ActionForm>`;
    expect(staleSelects('x.tsx', unkeyed)).toHaveLength(1);
    expect(staleSelects('x.tsx', keyed)).toHaveLength(0);
    expect(staleSelects('x.tsx', literal)).toHaveLength(0);
    expect(staleSelects('x.tsx', getForm)).toHaveLength(0);
    expect(staleSelects('x.tsx', wrapper)).toHaveLength(1);
  });
});

describe('savedStateKey', () => {
  it('changes when a saved value changes and not otherwise', () => {
    const before = { welcomeEmail: 'on_signup', mfa: 'optional' };
    expect(savedStateKey({ ...before })).toBe(savedStateKey(before));
    expect(savedStateKey({ ...before, welcomeEmail: 'on_verified' })).not.toBe(savedStateKey(before));
  });

  it('gives null and undefined a key', () => {
    expect(savedStateKey(undefined)).toBe('');
    expect(savedStateKey(null)).toBe('null');
  });
});
