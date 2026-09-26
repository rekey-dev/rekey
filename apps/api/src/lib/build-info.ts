/**
 * Which build is running: the release version and the git commit it was built
 * from.
 *
 * `/health/live` reports both so an operator can tell, from outside, whether a
 * deploy actually landed. npm once served 2.0.0-rc.9 as `latest` while
 * api.rekey.dev still ran an older build, and nothing anywhere could show it.
 *
 * **version** comes from `@rekey.dev/shared-types/package.json`. The CHANGELOG
 * states the packages share one version and release together with the API,
 * panel and portal, so that file IS the release version. (`apps/api`'s own
 * package.json is `0.0.0`: it is private and never published.) The file is
 * copied into the api-runtime image, so the value describes the code in the
 * image rather than anything the deploy environment claims. There is
 * deliberately no override variable: a second source is a way for the two to
 * disagree, which is the failure this exists to expose.
 * `createRequire` rather than an import attribute so this resolves identically
 * from `src/` under tsx and from `dist/` under node.
 * `test/openapi-contract.test.ts` pins it to the top CHANGELOG heading.
 *
 * **commit** is `REKEY_COMMIT`, baked in by the Dockerfile's build arg of the
 * same name (the hosted compose files pass it through). Anything that is not a
 * 7 to 40 character hex SHA reads as `unknown`, so a mistyped value cannot put
 * arbitrary text on a public, unauthenticated route.
 */

import { createRequire } from 'node:module';

export const RELEASE_VERSION: string = (
  createRequire(import.meta.url)('@rekey.dev/shared-types/package.json') as { version: string }
).version;

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;

export function resolveCommit(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  return COMMIT_SHA.test(value) ? value.toLowerCase() : 'unknown';
}

export const BUILD_INFO: Readonly<{ version: string; commit: string }> = Object.freeze({
  version: RELEASE_VERSION,
  commit: resolveCommit(process.env.REKEY_COMMIT),
});
