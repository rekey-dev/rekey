/**
 * Rules about the text the API sends: OpenAPI descriptions, error messages
 * and their `fix`, log lines. All of it is a string or template literal.
 */

import ts from 'typescript';
import type { SourceProgram } from './program.js';

const EM_DASH = String.fromCharCode(0x2014);

function isTextLiteral(node: ts.Node): node is ts.LiteralLikeNode {
  return (
    ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
  );
}

/**
 * Every string or template literal under `src` that holds an em dash, as
 * `path:line`. Comments are not text the API sends and are not reported.
 *
 * @example
 * expect(emDashLiterals(sourceProgram())).toEqual([]);
 */
export function emDashLiterals(program: SourceProgram): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isTextLiteral(node) && node.text.includes(EM_DASH)) found.push(program.at(node));
    ts.forEachChild(node, visit);
  };
  for (const file of program.files) visit(file);
  return found;
}
