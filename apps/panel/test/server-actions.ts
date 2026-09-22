/**
 * Source helpers shared by the guard tests that reason about Server Actions:
 * where they are, what their bodies say.
 *
 * A Server Action is either a function whose body starts with `'use server'`
 * (declared inside a page or layout), or an exported async function of a
 * module whose first statement is `'use server'`.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Comments blanked (offsets kept), so prose about the old shape is not code. */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));
}

/** Index just past the `}` matching the `{` at `open`. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * The `{` that opens the body of the function declared at `declAt`: past the
 * balanced parameter list, then past a return type that may itself hold
 * braces inside `<…>` (`Promise<{ ok: true }>`).
 */
function bodyOpen(text: string, declAt: number): number {
  let i = text.indexOf('(', declAt);
  let depth = 0;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  let angle = 0;
  for (i += 1; i < text.length; i += 1) {
    const c = text[i];
    if (c === '<') angle += 1;
    else if (c === '>' && text[i - 1] !== '=') angle -= 1;
    else if (c === '{' && angle === 0) return i;
  }
  return -1;
}

export interface ServerAction {
  name: string;
  /** Body text, comments blanked, braces included. */
  body: string;
  line: number;
}

export function serverActions(source: string): ServerAction[] {
  const text = stripComments(source);
  const lineOf = (at: number): number => text.slice(0, at).split('\n').length;
  const moduleLevel = /^\s*['"]use server['"];?/.test(text);
  const found: ServerAction[] = [];
  for (const m of text.matchAll(/\b(?:export\s+)?async\s+function\s+(\w+)\s*\(/g)) {
    const open = bodyOpen(text, m.index);
    if (open === -1) continue;
    const body = text.slice(open, matchBrace(text, open));
    const inline = /^\{\s*['"]use server['"]/.test(body);
    const exported = /^export\s/.test(m[0]);
    if (inline || (moduleLevel && exported)) {
      found.push({ name: m[1]!, body, line: lineOf(m.index) });
    }
  }
  return found;
}

/** Every named function declared in a file, by name, with its body. */
export function localFunctions(source: string): Map<string, string> {
  const text = stripComments(source);
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    const open = bodyOpen(text, m.index);
    if (open === -1) continue;
    out.set(m[1]!, text.slice(open, matchBrace(text, open)));
  }
  return out;
}

/**
 * True when `body` calls `redirect()` or `revalidatePath()`, directly or
 * through a function declared in the same file (`supportAction`,
 * `deviceAction` and friends).
 */
export function refreshesPage(body: string, fns: Map<string, string>, seen = new Set<string>()): boolean {
  if (/\bredirect\s*\(|\brevalidatePath\s*\(/.test(body)) return true;
  for (const [name, inner] of fns) {
    if (seen.has(name) || !new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    seen.add(name);
    if (refreshesPage(inner, fns, seen)) return true;
  }
  return false;
}
