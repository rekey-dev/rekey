/**
 * Which build of the panel is running, and the line the sidebar shows for it.
 *
 * The version is the shared release version from `@rekey.dev/shared-types`,
 * the same source the API reports on `/health/live`, inlined at build time so
 * it describes the code in this image. The commit is `REKEY_COMMIT`, set by the
 * Dockerfile's build argument, and reads as `unknown` unless it is a 7 to 40
 * character hex SHA.
 */

import sharedTypesPackage from '@rekey.dev/shared-types/package.json';

export interface BuildInfo {
  version: string;
  commit: string;
}

const COMMIT_SHA = /^[0-9a-f]{7,40}$/i;
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * A commit SHA in lower case, or `unknown` for anything else.
 *
 * @example
 * resolveCommit('A1B2C3D4'); // 'a1b2c3d4'
 * resolveCommit('main');     // 'unknown'
 */
export function resolveCommit(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  return COMMIT_SHA.test(value) ? value.toLowerCase() : 'unknown';
}

/** This panel build. */
export function panelBuild(): BuildInfo {
  return { version: sharedTypesPackage.version, commit: resolveCommit(process.env.REKEY_COMMIT) };
}

/**
 * Validate what `/health/live` answered. Null for anything that is not a
 * release version, so a proxy's error page never reaches the sidebar.
 *
 * @example
 * parseBuildInfo({ version: '2.2.0', commit: 'unknown' }); // { version: '2.2.0', commit: 'unknown' }
 * parseBuildInfo('<html>');                                // null
 */
export function parseBuildInfo(raw: unknown): BuildInfo | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { version, commit } = raw as { version?: unknown; commit?: unknown };
  if (typeof version !== 'string' || !RELEASE_VERSION.test(version)) return null;
  return { version, commit: resolveCommit(typeof commit === 'string' ? commit : undefined) };
}

/** Same version, and no known commit that says otherwise. */
function sameBuild(panel: BuildInfo, api: BuildInfo): boolean {
  const commitsDiffer =
    panel.commit !== 'unknown' && api.commit !== 'unknown' && panel.commit !== api.commit;
  return panel.version === api.version && !commitsDiffer;
}

function describe(b: BuildInfo): string {
  return b.commit === 'unknown' ? `v${b.version}` : `v${b.version} · ${b.commit.slice(0, 7)}`;
}

/**
 * The full version line, the badge's tooltip. One build when the panel and the
 * API agree, both when they differ, and nothing when the API did not answer:
 * the line exists to say what is deployed, and half an answer would mislead.
 *
 * @example
 * versionLine({ version: '2.2.0', commit: 'a1b2c3d' }, { version: '2.2.0', commit: 'a1b2c3d' });
 * // 'Rekey v2.2.0 · a1b2c3d'
 * versionLine({ version: '2.2.0', commit: 'unknown' }, { version: '2.1.0', commit: 'unknown' });
 * // 'Panel v2.2.0 · API v2.1.0'
 */
export function versionLine(panel: BuildInfo, api: BuildInfo | null): string | null {
  if (api === null) return null;
  if (sameBuild(panel, api)) {
    return `Rekey ${describe(api.commit === 'unknown' ? panel : api)}`;
  }
  return `Panel ${describe(panel)} · API ${describe(api)}`;
}

export interface VersionBadge {
  /** Short text for the badge, e.g. `v2.2.1`, or `v2.2.1 · API v2.2.0` when they differ. */
  label: string;
  /** Full line for the tooltip and screen readers. */
  title: string;
  /** The panel and the API are on different builds. */
  mismatch: boolean;
  /** Release notes for the version on the label. */
  href: string;
}

/**
 * The version badge beside the logo. Unlike `versionLine` it always renders:
 * the panel knows its own version without asking. When the API is on another
 * build or did not answer, the label says so in text, because a dot or a
 * tooltip is missed on touch screens and by a glance.
 *
 * @example
 * versionBadge({ version: '2.2.1', commit: 'unknown' }, null);
 * // { label: 'v2.2.1 · API ?', title: 'Panel v2.2.1 · API version unavailable', mismatch: false, href: '…/tag/v2.2.1' }
 */
export function versionBadge(panel: BuildInfo, api: BuildInfo | null): VersionBadge {
  const releases = 'https://github.com/rekey-dev/rekey/releases';
  const mismatch = api !== null && !sameBuild(panel, api);
  const apiSide = api === null ? ' · API ?' : mismatch && api.version !== panel.version ? ` · API v${api.version}` : '';
  return {
    label: `v${panel.version}${apiSide}`,
    title: versionLine(panel, api) ?? `Panel ${describe(panel)} · API version unavailable`,
    mismatch,
    // Two builds have two sets of notes; the list holds both.
    href: mismatch ? releases : `${releases}/tag/v${panel.version}`,
  };
}
