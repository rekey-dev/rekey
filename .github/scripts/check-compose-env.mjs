#!/usr/bin/env node
/**
 * Assert that every environment variable the API reads is actually reachable
 * inside the API container, for each compose file that runs one.
 *
 * ## Why this exists
 *
 * A compose `environment:` block is an ALLOWLIST. A variable that is not named
 * there never reaches the process, so setting it in Dokploy — or in `.env`, or
 * in the hosting dashboard — silently does nothing. The variable validates, the
 * container boots, the feature is simply off.
 *
 * That has now happened five separate times in this repo, and each occurrence
 * left behind a comment saying so and no guard:
 *
 *   - ADMIN_IP_ALLOWLIST   — the super-admin network gate was inert on every
 *                            deployment (comment in docker-compose.api.yml).
 *   - DEFAULT_APP_URL      — transactional emails silently omitted their button.
 *   - DEFAULT_TENANT_LIMITS— new workspaces were unlimited on a deploy that
 *                            believed it had set a ceiling.
 *   - PANEL_URL            — the hosted API relied on a default that was later
 *                            removed, and nothing set the variable.
 *   - OPERATOR_SIGNUP_MODE — a sibling compose file carries a comment warning
 *                            about this exact mistake having already no-opped
 *                            this exact variable once, and it was STILL missing
 *                            from docker-compose.prod.yml, the file DEPLOY.md
 *                            tells self-hosters to deploy. There was therefore
 *                            no way to close operator registration on a
 *                            documented self-host.
 *
 * Comments do not fail builds. This does — the same shape as the
 * `prisma migrate diff --exit-code` step next to it in ci.yml: a mechanical
 * comparison of two artifacts that are supposed to agree, with a non-zero exit
 * and an actionable message when they don't.
 *
 * ## What it checks
 *
 *   1. Every key declared in the `server` block of apps/api/src/config/env.ts
 *      appears in the `api` service's `environment:` block of each production
 *      compose file — or is listed in EXEMPT below with a reason.
 *   2. docker-compose.prod.yml — the self-host stack, and the one that ships to
 *      the public mirror — contains no `rekey.dev` literal. It carried five of
 *      them (API_URL, PUBLIC_WEBHOOK_BASE_URL, PUBLIC_PORTAL_URL,
 *      CORS_ALLOWED_ORIGINS, RESEND_DEFAULT_FROM) until 2.0.0-rc.3, which meant
 *      a self-hoster's Stripe account was configured to POST payment webhooks at
 *      Rekey's server.
 *
 * docker-compose.yml is deliberately NOT checked. It is the development stack:
 * the apps are normally run from a shell against it with the root `.env`, and
 * its `full` profile exists to boot the stack once, not to deploy one. Holding
 * it to a deployment file's completeness bar would add thirty lines that no
 * deployment ever reads.
 *
 * Usage: node .github/scripts/check-compose-env.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';

const ENV_TS = 'apps/api/src/config/env.ts';

/**
 * Keys a compose file is allowed to omit, with the reason. Adding an entry is a
 * deliberate act that shows up in review — which is the whole point, since the
 * alternative (say nothing, omit the key) is the bug this file exists to catch.
 */
const EXEMPT = {
  'docker-compose.prod.yml': {
    NODE_ENV: 'fixed to production by the file itself',
    PORT: 'container-internal — the healthcheck and the Traefik port label both hardcode 3030',
    HOST: 'container-internal — the container binds 0.0.0.0 and Traefik reaches it by service name',
  },
};

/** Compose files that run a production API, and the service that does it. */
const TARGETS = [
  { file: 'docker-compose.prod.yml', service: 'api' },
];

/**
 * Every key declared in the `server: { … }` object of env.ts.
 *
 * Deliberately a line regex rather than a TypeScript parse: the file is a flat
 * object literal of `KEY: z.…` entries at one indent level, and a dependency-free
 * check is one that still runs when the toolchain is what's broken. The count
 * assertion below is what stops a silent regex miss reporting "all good".
 */
function envKeys() {
  const src = readFileSync(ENV_TS, 'utf8');
  const start = src.indexOf('server: {');
  if (start === -1) throw new Error(`${ENV_TS}: could not find the \`server: {\` block.`);
  const keys = [];
  for (const line of src.slice(start).split('\n')) {
    const m = /^ {4}([A-Z][A-Z0-9_]*):\s*z\b/.exec(line);
    if (m) keys.push(m[1]);
  }
  if (keys.length < 20) {
    throw new Error(
      `${ENV_TS}: parsed only ${keys.length} keys — the file's shape changed and this check is no longer reading it. Fix the regex in ${import.meta.url}.`,
    );
  }
  return keys;
}

/**
 * The keys named in one service's `environment:` block.
 *
 * Same reasoning as above — no YAML dependency. Indentation is the structure:
 * the service is at two spaces, `environment:` at four, its keys at six.
 */
function composeEnvKeys(file, service) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inService = false;
  let inEnv = false;
  const keys = [];
  for (const line of lines) {
    if (/^ {2}[A-Za-z0-9_.-]+:\s*$/.test(line)) {
      inService = line.trim() === `${service}:`;
      inEnv = false;
      continue;
    }
    if (inService && /^ {4}[A-Za-z0-9_.-]+:/.test(line)) {
      inEnv = /^ {4}environment:\s*$/.test(line);
      continue;
    }
    if (inEnv) {
      const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):/.exec(line);
      if (m) keys.push(m[1]);
    }
  }
  if (keys.length === 0) {
    throw new Error(`${file}: found no \`environment:\` keys for service "${service}".`);
  }
  return keys;
}

const declared = envKeys();
const problems = [];

for (const { file, service } of TARGETS) {
  const present = new Set(composeEnvKeys(file, service));
  const exempt = EXEMPT[file] ?? {};
  const missing = declared.filter((k) => !present.has(k) && !(k in exempt));
  if (missing.length > 0) {
    problems.push(
      `${file} (service "${service}") is missing ${missing.length} key(s) the API reads:\n` +
        missing.map((k) => `    ${k}`).join('\n'),
    );
  }
}

// Guard 2 — no Rekey-owned hostname in the self-host stack.
const selfHost = readFileSync('docker-compose.prod.yml', 'utf8');
const leaked = selfHost
  .split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => /rekey\.dev/.test(line) && !/^\s*#/.test(line));
if (leaked.length > 0) {
  problems.push(
    'docker-compose.prod.yml contains Rekey-owned hostnames outside a comment:\n' +
      leaked.map(([n, line]) => `    ${n}: ${line.trim()}`).join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Build args have the same allowlist problem, one layer down.
//
// A `NEXT_PUBLIC_*` passed under `build.args:` in a compose file reaches Docker,
// and Docker DISCARDS it unless the Dockerfile declares a matching `ARG` — no
// error, just a build where Next inlines nothing and the app silently falls back
// to whatever its unset branch does. That is how the panel's "Continue with …"
// button shipped reading "your account" with the label set correctly in the
// deployment environment.
//
// Declaring the ARG is necessary but not sufficient: it also has to be passed
// on the `RUN` line that invokes the build, because that is what puts it in the
// build command's environment. Both are checked.
{
  const dockerfile = readFileSync('Dockerfile', 'utf8');
  const declaredArgs = new Set(
    [...dockerfile.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]),
  );
  const missing = [];
  // Discovered, not listed. A hardcoded list would have to name every hosted
  // unit's compose file, including ones the public strip removes — and this
  // script is the one thing under .github/scripts that survives that strip, so
  // naming them would fail the release tripwire. Discovery also means a compose
  // file added later is covered without anyone remembering to add it here.
  const composeFiles = readdirSync('.').filter(
    (f) => f.startsWith('docker-compose.') && f.endsWith('.yml'),
  );
  for (const file of composeFiles) {
    const text = readFileSync(file, 'utf8');
    const argsBlock = text.match(/build:[\s\S]*?args:([\s\S]*?)(?=\n {4}\w|\n {2}\w|$)/g) ?? [];
    for (const block of argsBlock) {
      for (const m of block.matchAll(/^\s+(NEXT_PUBLIC_[A-Z0-9_]+):/gm)) {
        const name = m[1];
        if (!declaredArgs.has(name)) {
          missing.push(`${file} passes ${name} as a build arg, but the Dockerfile declares no matching ARG`);
        } else if (!new RegExp(`${name}=\\$${name}`).test(dockerfile)) {
          missing.push(`${file} passes ${name}, and the Dockerfile declares the ARG, but never forwards it on a RUN line`);
        }
      }
    }
  }
  if (missing.length > 0) problems.push(...missing);
}

if (problems.length > 0) {
  console.error('Compose environment check FAILED.\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(
    'A compose `environment:` block is an allowlist: a variable missing from it\n' +
      'never reaches the container, so setting it in the hosting dashboard does\n' +
      'nothing. Add each key as `KEY: ${KEY:-}` (empty is the same as unset — the\n' +
      "API's env schema sets `emptyStringAsUndefined`), or add it to EXEMPT in\n" +
      '.github/scripts/check-compose-env.mjs with the reason it does not belong.',
  );
  process.exit(1);
}

console.log(
  `Compose environment check passed — ${declared.length} keys from ${ENV_TS} accounted for in ${TARGETS.length} compose file(s).`,
);
