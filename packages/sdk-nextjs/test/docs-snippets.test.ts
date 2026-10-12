/**
 * Type-checks the TypeScript samples in the docs.
 *
 * Every fenced block marked `ts` or `tsx` in `docs/*.md` and in the SDK
 * READMEs is compiled against the built packages with this package's strict
 * options. A sample that names a method, a field or an import that does not
 * exist fails here, with the file and the line of the sample.
 *
 * A block that cannot stand alone is opted out on the line before its fence:
 *
 *     <!-- snippet: no-check a diff, not a program -->
 *
 * The reason is required. Samples may use the values declared in `PRELUDE`
 * without importing them.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const repoRoot = path.resolve(pkgRoot, '../..');

const PACKAGE_DOCS = [
  'packages/sdk-node/README.md',
  'packages/sdk-node/AGENTS.md',
  'packages/sdk-react/README.md',
  'packages/sdk-react/AGENTS.md',
  'packages/sdk-nextjs/README.md',
  'packages/sdk-nextjs/AGENTS.md',
  'packages/sdk-astro/README.md',
  'packages/shared-types/README.md',
];

/** What a sample may use without declaring it. Global, so a sample that declares its own `rekey` shadows this one. */
const PRELUDE = `
import type { Rekey as RekeyClient, RekeyOperator } from '@rekey.dev/node';
import type { RekeyBrowserClient } from '@rekey.dev/react';

declare global {
  const rekey: RekeyClient;
  const operator: RekeyOperator;
  const client: RekeyBrowserClient;
  const accessToken: string;
  const userAccessToken: string;
  const successUrl: string;
  const cancelUrl: string;
  function show(message: string): void;
  function redirectTo(url: string): never;
  function confirmWithBuyer(message: string): Promise<void>;
  function archive(entries: readonly unknown[]): Promise<void>;
}
export {};
`;

/** The reader's own module that holds their client. Ambient, so it sits in a file with no import of its own. */
const APP_MODULES = `
declare module '@/lib/rekey' {
  export const rekey: import('@rekey.dev/node').Rekey;
}
`;

interface Snippet {
  doc: string;
  /** 1-based line of the opening fence. */
  fenceLine: number;
  lang: 'ts' | 'tsx';
  code: string;
}

interface Skipped {
  doc: string;
  fenceLine: number;
  reason: string;
}

const NO_CHECK = /^<!--\s*snippet:\s*no-check\s*(.*?)\s*-->$/;

function docFiles(): string[] {
  const guides = readdirSync(path.join(repoRoot, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `docs/${name}`);
  return [...guides, ...PACKAGE_DOCS];
}

function extract(doc: string): { snippets: Snippet[]; skipped: Skipped[]; unjustified: number[] } {
  const lines = readFileSync(path.join(repoRoot, doc), 'utf8').split('\n');
  const snippets: Snippet[] = [];
  const skipped: Skipped[] = [];
  const unjustified: number[] = [];
  let open: { fence: string; lang: string; line: number; body: string[] } | null = null;

  lines.forEach((line, index) => {
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/.exec(line);
    if (open === null) {
      if (fence) open = { fence: fence[1] ?? '```', lang: (fence[2] ?? '').toLowerCase(), line: index + 1, body: [] };
      return;
    }
    if (!fence || fence[1] !== open.fence || fence[2] !== '') {
      open.body.push(line);
      return;
    }
    const block = open;
    open = null;
    if (block.lang !== 'ts' && block.lang !== 'tsx') return;
    const optOut = NO_CHECK.exec((lines[block.line - 2] ?? '').trim());
    if (optOut) {
      const reason = optOut[1] ?? '';
      if (reason === '') unjustified.push(block.line);
      skipped.push({ doc, fenceLine: block.line, reason });
      return;
    }
    snippets.push({ doc, fenceLine: block.line, lang: block.lang, code: block.body.join('\n') });
  });
  return { snippets, skipped, unjustified };
}

const SELF_PATHS: Record<string, string[]> = {
  '@rekey.dev/nextjs': ['./src/index.ts'],
  '@rekey.dev/nextjs/*': ['./src/*.ts'],
  '@rekey.dev/astro': ['../sdk-astro/src/index.ts'],
};

function compile(files: string[]): readonly ts.Diagnostic[] {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node'],
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    skipLibCheck: true,
    esModuleInterop: true,
    isolatedModules: true,
    noEmit: true,
    baseUrl: pkgRoot,
    paths: SELF_PATHS,
  };
  const program = ts.createProgram(files, options);
  return ts.getPreEmitDiagnostics(program);
}

/** An import of the reader's own file, such as `./actions`, which no sample can supply. */
function isReadersOwnModule(diagnostic: ts.Diagnostic): boolean {
  if (diagnostic.code !== 2307) return false;
  const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  return /Cannot find module '\.{1,2}\//.test(text);
}

describe('the TypeScript samples in the docs', () => {
  it('compile against the built packages', { timeout: 300_000 }, () => {
    const all = docFiles().map((doc) => ({ doc, ...extract(doc) }));
    const unjustified = all.flatMap(({ doc, unjustified: lines }) => lines.map((line) => `${doc}:${line}`));
    expect(unjustified, 'a `snippet: no-check` comment needs a reason').toEqual([]);

    const dir = path.join(pkgRoot, `.docs-snippets-${process.pid}`);
    const byFile = new Map<string, Snippet>();
    const failures: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      const prelude = path.join(dir, 'prelude.d.ts');
      const appModules = path.join(dir, 'app-modules.d.ts');
      writeFileSync(prelude, PRELUDE);
      writeFileSync(appModules, APP_MODULES);
      all.forEach(({ snippets }) =>
        snippets.forEach((snippet) => {
          const name = `${snippet.doc.replace(/[^A-Za-z0-9]+/g, '_')}_L${snippet.fenceLine}.${snippet.lang}`;
          const file = path.join(dir, name);
          // Appended, so a diagnostic's line is the sample's own line.
          writeFileSync(file, `${snippet.code}\nexport {};\n`);
          byFile.set(file, snippet);
        }),
      );

      for (const diagnostic of compile([prelude, appModules, ...byFile.keys()])) {
        if (isReadersOwnModule(diagnostic)) continue;
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
        const snippet = diagnostic.file ? byFile.get(path.resolve(diagnostic.file.fileName)) : undefined;
        if (!snippet || !diagnostic.file || diagnostic.start === undefined) {
          failures.push(`${diagnostic.file?.fileName ?? 'compiler'}: TS${diagnostic.code} ${message}`);
          continue;
        }
        const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        failures.push(`${snippet.doc}:${snippet.fenceLine + 1 + line} (sample at line ${snippet.fenceLine}): TS${diagnostic.code} ${message}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const report = all
      .filter(({ snippets, skipped }) => snippets.length + skipped.length > 0)
      .map(({ doc, snippets, skipped }) => `  ${doc}: ${snippets.length} checked, ${skipped.length} skipped`);
    const checked = all.reduce((sum, { snippets }) => sum + snippets.length, 0);
    const skippedCount = all.reduce((sum, { skipped }) => sum + skipped.length, 0);
    console.log(`docs samples: ${checked} checked, ${skippedCount} skipped\n${report.join('\n')}`);

    expect(checked, 'no sample was found: the extractor is broken').toBeGreaterThan(0);
    expect(failures, `${failures.length} problem(s) in the docs samples:\n${failures.join('\n')}\n`).toEqual([]);
  });
});
