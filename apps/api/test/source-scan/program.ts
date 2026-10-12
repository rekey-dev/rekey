/**
 * One type-checked view of `apps/api/src`, for tests that hold a rule over the
 * whole source tree. Text matching misses shorthand properties, spreads and
 * values built in a variable; the compiler does not.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(API_ROOT, 'src');

export interface SourceProgram {
  checker: ts.TypeChecker;
  /** Every file under `src`, generated code and tests left out. */
  files: readonly ts.SourceFile[];
  /** A file's path from `apps/api`, with forward slashes. */
  relative(file: ts.SourceFile): string;
  /** `path:line` for a finding. */
  at(node: ts.Node): string;
}

let cached: SourceProgram | null = null;

/**
 * The program, built once per test worker. `planted` adds source files that
 * exist only in memory, keyed by their path under `apps/api`, so a test can
 * show a rule catching a violation without writing one to disk.
 *
 * @example
 * const { checker, files } = sourceProgram();
 * const withBug = sourceProgram({ 'src/modules/billing/__planted__.ts': 'export const x = 1;' });
 */
export function sourceProgram(planted?: Readonly<Record<string, string>>): SourceProgram {
  if (planted === undefined && cached !== null) return cached;
  const configPath = path.join(API_ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, API_ROOT);
  const options = { ...parsed.options, noEmit: true };
  const extra = new Map(Object.entries(planted ?? {}).map(([relative, text]) => [path.join(API_ROOT, relative), text]));
  const host = ts.createCompilerHost(options);
  const readFromDisk = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = extra.get(path.normalize(fileName));
    return text === undefined
      ? readFromDisk(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  const exists = host.fileExists.bind(host);
  host.fileExists = (fileName) => extra.has(path.normalize(fileName)) || exists(fileName);
  const program = ts.createProgram({ rootNames: [...parsed.fileNames, ...extra.keys()], options, host });
  const relative = (file: ts.SourceFile): string => path.relative(API_ROOT, file.fileName).split(path.sep).join('/');
  const files = program
    .getSourceFiles()
    .filter((file) => file.fileName.startsWith(SRC_ROOT + path.sep))
    .filter((file) => !file.isDeclarationFile && !file.fileName.includes(`${path.sep}__tests__${path.sep}`));
  const built: SourceProgram = {
    checker: program.getTypeChecker(),
    files,
    relative,
    at(node) {
      const file = node.getSourceFile();
      const { line } = file.getLineAndCharacterOfPosition(node.getStart());
      return `${relative(file)}:${line + 1}`;
    },
  };
  if (planted === undefined) cached = built;
  return built;
}

/**
 * Whether a symbol is declared inside the named type of the generated Prisma
 * client, such as the `amount` of `$PlanPayload`.
 *
 * @example
 * declaredIn(checker.getSymbolAtLocation(node.name), ['$PlanPayload']);
 */
export function declaredIn(symbol: ts.Symbol | undefined, typeNames: readonly string[]): boolean {
  for (const declaration of symbol?.declarations ?? []) {
    for (let node: ts.Node | undefined = declaration; node !== undefined; node = node.parent) {
      if (
        (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
        typeNames.includes(node.name.text)
      ) {
        return true;
      }
    }
  }
  return false;
}
