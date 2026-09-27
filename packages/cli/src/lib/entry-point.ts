import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module at `moduleUrl` is the file Node was started with.
 *
 * Compares real paths because npx and `node_modules/.bin` start the bin through
 * a symlink: `process.argv[1]` is the link while `import.meta.url` is the
 * resolved file, so a plain URL comparison never matches and the bin exits 0
 * having done nothing. A plain `import` of the package still answers false.
 *
 * @example
 * if (isEntryPoint(import.meta.url)) void main();
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
