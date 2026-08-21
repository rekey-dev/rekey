#!/usr/bin/env node
/**
 * Which suites a change can possibly affect, so CI can skip the ones it cannot.
 *
 * The Test job is ~14 minutes. Running it because someone rewrote a comment is
 * not caution, it is a tax on every unrelated change, and a pipeline that slow
 * stops being trusted and starts being worked around.
 *
 * The whole design is one asymmetry: skipping a suite that would have caught
 * something is a real failure, and running a suite that finds nothing costs
 * minutes. So every uncertainty resolves toward RUNNING. An unrecognised path
 * runs everything, a diff that cannot be computed runs everything, a file that
 * will not parse counts as changed, a push to main runs everything. Only a
 * provably inert change is allowed to skip.
 *
 * There are two independent reasons a file can be inert:
 *
 *   1. Its PATH cannot matter (docs/, top-level markdown). A short, boring
 *      list, because this is where being wrong silently drops coverage.
 *   2. Its CONTENT did not really change: the TypeScript AST before and after
 *      is identical, so the edit was comments or whitespace. This is decided by
 *      the actual compiler, not a regex over the diff, which is the only way it
 *      is safe around strings that contain `//`, template literals, and JSX.
 *
 * Deliberately NOT relied on here: `Typecheck` is never skipped, so directives
 * that live in comments and change compilation (`@ts-expect-error`) are still
 * caught even though this file treats them as inert.
 *
 * Outputs, written as `name=true|false` to $GITHUB_OUTPUT:
 *   api       the API suite, the migration checks, the OpenAPI spec
 *   packages  the workspaces ci.yml's package-test step covers
 *   build     the Next builds
 *   full      everything ran, because the change was unclassifiable or forced
 *
 * Force a full run, any of:
 *   - a `ci:full` label on the pull request
 *   - `[ci full]` in the head commit message
 *   - the "Run the full suite" box on a manual workflow_dispatch
 *   - any push to main, which never guesses
 *
 * Self-test: `node .github/scripts/changed-areas.mjs --self-test`
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * Paths whose contents cannot change behaviour under test.
 *
 * Short on purpose. Notably absent: anything under `apps/` or `packages/`,
 * including their markdown, because a README inside a workspace still sits in a
 * build input; and `.github/`, because a workflow edit changes how every other
 * job runs.
 */
const INERT_PATHS = [
  /^docs\//,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/PULL_REQUEST_TEMPLATE(\.md)?$/,
  /^[^/]+\.md$/, // top-level prose: README, CHANGELOG, decisions, AGENTS
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.vscode\//,
  /^\.idea\//,
];

/** Anything here re-runs everything: it changes how the other jobs behave. */
const GLOBAL_PATHS = [
  /^\.github\//, // workflows, composite actions, scripts, including this file
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^package\.json$/,
  /^turbo\.json$/,
  /^tsconfig(\.[^/]+)?\.json$/,
  /^Dockerfile/,
  /^docker-compose/,
];

const ALL = { api: true, packages: true, build: true, full: true };

/**
 * Which workspaces the "Run package + app tests" step actually covers.
 *
 * Read out of ci.yml rather than written down here, because a hardcoded list is
 * a second copy of a fact that already exists: every app in this repo has a
 * `test` script, but only some are in that step's `--filter=` list, so the
 * package.json files cannot answer the question and only the workflow can. A
 * copy would drift the moment a workspace joins or leaves the filter, and it
 * would drift SILENTLY toward running less.
 *
 * It also keeps this file free of workspace names, which matters because it is
 * mirrored to the public repository while some of those workspaces are not. The
 * strip edits the filter list in ci.yml; deriving from it means this file needs
 * no editing at all and cannot disagree with the mirror it ships to.
 *
 * @param {string} ciYaml
 * @param {Record<string,string>} nameToDir workspace package name to directory
 * @returns {RegExp[]|null} null when the step cannot be parsed
 */
export function testedPaths(ciYaml, nameToDir) {
  const step = ciYaml.split('Run package + app tests')[1];
  if (!step) return null;
  // Stop at the next step or job so a later `--filter=` cannot be swept in.
  const body = step.split(/\n {0,4}[a-z-]+:|\n\s*- name:/)[0];
  const filters = [...body.matchAll(/--filter=(?:"([^"]+)"|(\S+))/g)].map((m) => m[1] ?? m[2]);
  if (filters.length === 0) return null;

  const out = [];
  for (const filter of filters) {
    if (filter.startsWith('./')) {
      // A path glob such as ./packages/*, so take the directory it roots at.
      const root = filter.slice(2).split('/')[0];
      out.push(new RegExp(`^${root}/`));
      continue;
    }
    const dir = nameToDir[filter];
    if (!dir) return null; // a name we cannot place: do not guess
    out.push(new RegExp(`^${dir}/`));
  }
  return out;
}

/**
 * A path may match several areas; every match turns that area on.
 *
 * `packages/**` appears in all three because every workspace consumes it: the
 * API imports it, the package suites test it, the apps build against it.
 *
 * @param {RegExp[]|null} tested from `testedPaths`; null falls back to treating
 *   every non-API app as tested, which over-runs rather than under-runs
 */
export function buildAreas(tested) {
  return {
    api: [/^apps\/api\//, /^prisma\//, /^packages\//],
    packages: tested ?? [/^packages\//, /^apps\/(?!api\/)/],
    build: [/^apps\//, /^packages\//],
  };
}

/**
 * Classify a list of changed paths.
 *
 * Pure, so the self-test can drive it with no git repository and no GitHub
 * event. `sawInertOnly` distinguishes "the diff was empty because nothing
 * changed", which is unknown territory and runs everything, from "every changed
 * file was proved inert", which is the whole point and runs nothing.
 *
 * @param {string[]} files
 * @param {{sawInertOnly?: boolean, areas?: object}} [opts]
 */
export function classify(files, opts = {}) {
  const AREAS = opts.areas ?? buildAreas(null);
  if (files.length === 0) {
    return opts.sawInertOnly
      ? {
          result: { api: false, packages: false, build: false, full: false },
          reason: 'every changed file was inert',
        }
      : { result: { ...ALL }, reason: 'empty diff, so nothing is known' };
  }

  const result = { api: false, packages: false, build: false, full: false };
  const unclassified = [];

  for (const file of files) {
    if (INERT_PATHS.some((re) => re.test(file))) continue;
    if (GLOBAL_PATHS.some((re) => re.test(file))) {
      return { result: { ...ALL }, reason: `${file} affects the pipeline itself` };
    }
    let matched = false;
    for (const [area, patterns] of Object.entries(AREAS)) {
      if (patterns.some((re) => re.test(file))) {
        result[area] = true;
        matched = true;
      }
    }
    if (!matched) unclassified.push(file);
  }

  if (unclassified.length > 0) {
    return {
      result: { ...ALL },
      reason: `unclassified path(s): ${unclassified.slice(0, 5).join(', ')}`,
    };
  }
  return { result, reason: `${files.length} file(s) classified` };
}

/* -------------------------------------------------------------------------- */
/* Content-level inertness: did the code actually change, or only the prose?    */

const PARSEABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

let cachedTs;
function typescript() {
  if (cachedTs === undefined) {
    try {
      cachedTs = require('typescript');
    } catch {
      cachedTs = null;
    }
  }
  return cachedTs;
}

/**
 * A fingerprint of everything in a source file that is not a comment.
 *
 * Built from the TypeScript AST rather than the text, so the answer is the
 * compiler's, not a heuristic's: a `//` inside a string literal stays
 * significant, JSX text stays significant, and reformatting does not.
 *
 * JSDoc nodes are excluded. They are part of the AST but carry no runtime
 * meaning here (this repo has no `@__PURE__` or `@jsxImportSource` pragmas, and
 * `@ts-*` directives are line comments whose effect is on Typecheck, which is
 * never skipped). Without this exclusion the check would be useless in a
 * codebase whose house style is large block comments.
 *
 * @returns {string|null} null when the file will not parse, which counts as changed
 */
export function astFingerprint(fileName, source) {
  const ts = typescript();
  if (!ts) return null; // no compiler available: treat every file as changed
  try {
    const kind = /\.(tsx|jsx)$/.test(fileName) ? ts.ScriptKind.TSX : undefined;
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
    // A file with a syntax error parses into a partial tree rather than
    // throwing, and comparing two partial trees proves nothing.
    if (sf.parseDiagnostics?.length) return null;

    const out = [];
    const walk = (node) => {
      if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) {
        return;
      }
      out.push(node.kind);
      const kids = node.getChildren(sf);
      if (kids.length === 0) out.push(source.slice(node.getStart(sf), node.getEnd()));
      for (const kid of kids) walk(kid);
    };
    walk(sf);
    return out.join(' ');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * Map every workspace's package name to its directory, so a `--filter=` naming
 * a package can be turned back into the paths that belong to it.
 */
export function workspaceDirs(root = '.') {
  const dirs = {};
  for (const parent of ['apps', 'packages']) {
    let entries;
    try {
      entries = readdirSync(`${root}/${parent}`, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const pkg = JSON.parse(readFileSync(`${root}/${parent}/${entry.name}/package.json`, 'utf8'));
        if (pkg.name) dirs[pkg.name] = `${parent}/${entry.name}`;
      } catch {
        // Not a workspace, or unreadable. Nothing to map.
      }
    }
  }
  return dirs;
}

/** Every case that has to keep holding. Runs in CI as its own step. */
function selfTest() {
  // A synthetic area map, so these cases assert the CLASSIFIER and do not
  // quietly change meaning when a workspace joins or leaves ci.yml's filters.
  const areas = buildAreas([/^packages\//, /^apps\/tested\//]);
  const pathCases = [
    ['docs only', ['docs/auth.md'], { api: false, packages: false, build: false }],
    [
      'top-level prose',
      ['README.md', 'decisions.md'],
      { api: false, packages: false, build: false },
    ],
    ['panel UI only', ['apps/panel/src/app/page.tsx'], { api: false, packages: false, build: true }],
    ['api source', ['apps/api/src/app.ts'], { api: true, packages: false, build: true }],
    [
      'migration',
      ['prisma/migrations/1_x/migration.sql'],
      { api: true, packages: false, build: false },
    ],
    ['a package', ['packages/react/src/index.ts'], { api: true, packages: true, build: true }],
    // An app that ci.yml's package-test step covers: its suite must run, and it
    // still cannot affect the API.
    ['a tested app', ['apps/tested/src/lib/session.ts'], { api: false, packages: true, build: true }],
    [
      'docs plus api',
      ['docs/auth.md', 'apps/api/src/app.ts'],
      { api: true, packages: false, build: true },
    ],
    ['workflow edit', ['.github/workflows/ci.yml'], { full: true }],
    ['this script', ['.github/scripts/changed-areas.mjs'], { full: true }],
    ['lockfile', ['pnpm-lock.yaml'], { full: true }],
    ['unknown top-level dir', ['newthing/index.ts'], { full: true }],
    ['empty diff', [], { full: true }],
    // A README INSIDE a workspace is not inert: it sits in a build input.
    ['package readme', ['packages/react/README.md'], { api: true, packages: true, build: true }],
  ];

  let failed = 0;
  const check = (name, got, key, want) => {
    if (got !== want) {
      console.error(`FAIL ${name}: ${key} was ${got}, expected ${want}`);
      failed++;
    }
  };

  for (const [name, files, want] of pathCases) {
    const { result } = classify(files, { areas });
    for (const [key, expected] of Object.entries(want)) check(name, result[key], key, expected);
  }

  // Everything inert must mean nothing runs, which is the only case where a
  // skip actually happens.
  check('all inert', classify([], { sawInertOnly: true, areas }).result.api, 'api', false);

  // Reading the tested workspaces back out of ci.yml.
  const yaml = [
    '      - name: Run package + app tests',
    '        run: >-',
    '          pnpm exec turbo run test --concurrency=1',
    '          --filter="./packages/*"',
    '          --filter=@scope/one',
    '          --filter=@scope/two',
    '',
    '  build:',
    '    steps:',
    '      - run: turbo build --filter=@scope/three',
  ].join('\n');
  const parsed = testedPaths(yaml, { '@scope/one': 'apps/one', '@scope/two': 'apps/two' });
  check('filters parsed', parsed?.length, 'count', 3);
  check('glob filter', parsed?.[0].test('packages/x/y.ts'), 'packages/', true);
  check('named filter', parsed?.[1].test('apps/one/y.ts'), 'apps/one/', true);
  // A `--filter=` belonging to a LATER step must not be swept in.
  check('later step ignored', parsed?.some((re) => re.test('apps/three/y.ts')), 'apps/three/', false);
  // An unknown package name means the mapping is incomplete, and guessing there
  // would silently shrink what runs.
  check('unknown name', testedPaths(yaml, {}), 'result', null);
  check('missing step', testedPaths('nothing here', {}), 'result', null);
  // The fallback must over-run, never under-run: with no parse, every non-API
  // app counts as tested.
  check(
    'fallback over-runs',
    classify(['apps/anything/x.ts'], { areas: buildAreas(null) }).result.packages,
    'packages',
    true,
  );

  const fpCases = [
    ['line comment', 'x.ts', 'const x=1; // old', 'const x=1; // new', true],
    [
      'block comment',
      'x.ts',
      '/** doc - here */\nexport const y=2;',
      '/** better doc */\nexport const y=2;',
      true,
    ],
    ['blank lines', 'x.ts', 'const a=1;\n\n\nconst b=2;', 'const a=1;\nconst b=2;', true],
    [
      'jsx with comment edit',
      'x.tsx',
      'export const A=()=><p>Hi</p>; // c1',
      'export const A=()=><p>Hi</p>; // c2',
      true,
    ],
    // Everything below must be seen as a REAL change.
    [
      'comment-lookalike in a string',
      'x.ts',
      'const s = "// not a comment";',
      'const s = "// CHANGED";',
      false,
    ],
    ['template literal', 'x.ts', 'const s = `/* x */`;', 'const s = `/* y */`;', false],
    [
      'jsx text',
      'x.tsx',
      'export const A=()=><p>Hello</p>;',
      'export const A=()=><p>Goodbye</p>;',
      false,
    ],
    ['operator', 'x.ts', 'if (a <= b) {}', 'if (a < b) {}', false],
    ['string content', 'x.ts', 'throw new Error("nope");', 'throw new Error("yep");', false],
  ];
  if (!typescript()) {
    // Without the compiler every file counts as changed, so the cases below
    // would all "fail" while the script is behaving correctly. In CI the
    // install has already run, so this only fires on a bare tree.
    console.log('changed-areas: no typescript, skipping the comment-detection cases');
  } else {
    for (const [name, file, a, b, wantSame] of fpCases) {
      const fa = astFingerprint(file, a);
      const fb = astFingerprint(file, b);
      check(`fingerprint: ${name}`, fa !== null && fa === fb, 'same', wantSame);
    }
    // A file that will not parse must never be called inert.
    check('unparseable', astFingerprint('x.ts', 'const = = ;'), 'fingerprint', null);
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("changed-areas: all assertions pass");
}

/* -------------------------------------------------------------------------- */

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** File content at a ref, or null when the file did not exist there. */
function contentAt(ref, file) {
  try {
    // stderr is swallowed on purpose: "exists on disk, but not in HEAD^" is the
    // expected answer for every added file, and letting git print it turns a
    // normal run into a log full of what look like errors.
    return execFileSync('git', ['show', `${ref}:${file}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function main() {
  const out = process.env.GITHUB_OUTPUT;
  const eventName = process.env.GITHUB_EVENT_NAME ?? '';
  const baseRef = process.env.CHANGED_BASE_REF ?? '';
  const labels = (process.env.CHANGED_PR_LABELS ?? '').toLowerCase();
  const dispatchFull = (process.env.CHANGED_FORCE_FULL ?? '').toLowerCase() === 'true';
  // Both, because neither is available on both event types: `head_commit` is
  // push-only, and on a pull request the checked-out HEAD is GitHub's synthetic
  // merge commit, whose message is "Merge ... into ..." rather than anything a
  // person wrote.
  const text = [process.env.CHANGED_COMMIT_MESSAGE, process.env.CHANGED_PR_TITLE]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  const emit = (values, reason) => {
    console.log(`# ${reason}`);
    const lines = Object.entries(values)
      .map(([k, v]) => `${k}=${v ? 'true' : 'false'}`)
      .join('\n');
    console.log(lines);
    if (out) appendFileSync(out, lines + '\n');
  };

  const hasLabel = labels
    .split(',')
    .map((l) => l.trim())
    .includes('ci:full');

  let forcedBy = null;
  if (eventName === 'push') forcedBy = 'push to a shared branch';
  else if (dispatchFull) forcedBy = 'the full-suite box on this manual run';
  else if (hasLabel) forcedBy = 'the ci:full label';
  else if (text.includes('[ci full]')) forcedBy = '[ci full] in the title or commit message';

  if (forcedBy) {
    emit({ ...ALL }, `running everything: ${forcedBy}`);
    return;
  }

  let changed;
  try {
    // `...` is the merge base, so this is what the pull request changed rather
    // than everything that landed on the base branch since it was cut. Needs
    // `fetch-depth: 0` on the checkout or the merge base is not in the clone.
    const range = baseRef ? `origin/${baseRef}...HEAD` : 'HEAD^...HEAD';
    changed = git('diff', '--name-only', range)
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch (err) {
    emit({ ...ALL }, `could not compute the diff (${String(err.message).split('\n')[0]})`);
    return;
  }

  const base = baseRef ? `origin/${baseRef}` : 'HEAD^';
  const significant = [];
  let commentOnly = 0;

  for (const file of changed) {
    if (!PARSEABLE.test(file)) {
      significant.push(file);
      continue;
    }
    const before = contentAt(base, file);
    let after;
    try {
      after = readFileSync(file, 'utf8');
    } catch {
      after = null; // deleted
    }
    // Added or deleted, so there is nothing to compare against.
    if (before === null || after === null) {
      significant.push(file);
      continue;
    }
    const fa = astFingerprint(file, before);
    const fb = astFingerprint(file, after);
    if (fa !== null && fa === fb) {
      commentOnly++;
      console.log(`# comments or whitespace only: ${file}`);
      continue;
    }
    significant.push(file);
  }

  let tested = null;
  try {
    tested = testedPaths(readFileSync('.github/workflows/ci.yml', 'utf8'), workspaceDirs());
  } catch {
    // Falls back to treating every non-API app as tested.
  }
  if (!tested) console.log('# could not read ci.yml filters, over-running instead');

  const inertPaths = significant.filter((f) => INERT_PATHS.some((re) => re.test(f))).length;
  const { result, reason } = classify(significant, {
    areas: buildAreas(tested),
    sawInertOnly: changed.length > 0 && (commentOnly > 0 || inertPaths > 0),
  });
  emit(
    result,
    `${changed.length} changed, ${commentOnly} comment-only, ${significant.length} significant: ${reason}`,
  );
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
