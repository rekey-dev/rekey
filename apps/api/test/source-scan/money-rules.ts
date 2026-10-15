/**
 * The two money rules held over the whole source tree, as functions of a
 * type-checked program so a test can also point them at a planted violation.
 *
 *   1. A subscription's `planPriceId`, `currency` and `unitAmount` are
 *      written in `billing/subscription-snapshot.ts` and nowhere else.
 *   2. A plan row is written in `plans/default-price.ts` and nowhere else,
 *      because that file keeps the default price row and `isFree` with it.
 *   3. No raw SQL names a money column that no longer exists. The compiler
 *      refuses a typed read of one; it cannot read a SQL string.
 */

import ts from 'typescript';
import type { SourceProgram } from './program.js';

export const SUBSCRIPTION_PRICE_WRITER = 'src/modules/billing/subscription-snapshot.ts';
export const PLAN_PRICE_OWNER = 'src/modules/plans/default-price.ts';

const SUBSCRIPTION_PRICE_COLUMNS = ['planPriceId', 'currency', 'unitAmount'] as const;
const WRITE_METHODS = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert']);
const WRITE_ARGUMENT_KEYS = new Set(['data', 'create', 'update']);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** `tx.subscription.update(...)` and the like: the model name and method of a Prisma delegate call. */
function delegateCall(node: ts.Node): { model: string; method: string; args: ts.Expression | undefined } | null {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const receiver = node.expression.expression;
  if (!ts.isPropertyAccessExpression(receiver)) return null;
  return { model: receiver.name.text, method: node.expression.name.text, args: node.arguments[0] };
}

function typeHasAny(checker: ts.TypeChecker, type: ts.Type, names: readonly string[]): string | null {
  const members = type.isUnion() ? type.types : [type];
  for (const member of members) {
    const element = checker.isArrayType(member) ? checker.getTypeArguments(member as ts.TypeReference)[0] : undefined;
    const target = element ?? member;
    for (const name of names) if (target.getProperty(name) !== undefined) return name;
  }
  return null;
}

/**
 * Every write to a subscription outside the one writer that carries a price
 * column: named, shorthand, spread in, or held in a variable passed as `data`.
 *
 * @example
 * expect(subscriptionPriceWrites(sourceProgram())).toEqual([]);
 */
export function subscriptionPriceWrites(program: SourceProgram): string[] {
  const found: string[] = [];
  for (const file of program.files) {
    if (program.relative(file) === SUBSCRIPTION_PRICE_WRITER) continue;
    walk(file, (node) => {
      const call = delegateCall(node);
      if (call !== null && call.model === 'subscription' && WRITE_METHODS.has(call.method) && call.args !== undefined) {
        if (!ts.isObjectLiteralExpression(call.args)) {
          found.push(`${program.at(node)} subscription.${call.method} with arguments built elsewhere`);
          return;
        }
        for (const property of call.args.properties) {
          const key = property.name !== undefined && ts.isIdentifier(property.name) ? property.name.text : null;
          if (key === null || !WRITE_ARGUMENT_KEYS.has(key)) continue;
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name!;
          const column = typeHasAny(program.checker, program.checker.getTypeAtLocation(value), SUBSCRIPTION_PRICE_COLUMNS);
          if (column !== null) found.push(`${program.at(property)} subscription.${call.method} ${key} carries ${column}`);
        }
      }
      // A subscription written through another model's nested write.
      if (ts.isObjectLiteralExpression(node)) {
        const contextual = program.checker.getContextualType(node);
        const name = contextual === undefined ? '' : program.checker.typeToString(contextual);
        if (/\bSubscription(Unchecked)?(Create|Update)\w*Input\b/.test(name)) {
          const column = typeHasAny(program.checker, program.checker.getTypeAtLocation(node), SUBSCRIPTION_PRICE_COLUMNS);
          if (column !== null) found.push(`${program.at(node)} nested subscription write carries ${column}`);
        }
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
        const text = node.getText();
        if (
          /(UPDATE\s+"subscriptions"|INSERT\s+INTO\s+"subscriptions")/i.test(text) &&
          /"plan_price_id"|"unit_amount"|"currency"/.test(text)
        ) {
          found.push(`${program.at(node)} raw SQL writes a subscription price column`);
        }
      }
    });
  }
  return [...new Set(found)];
}

/** Columns the money model dropped, by table. */
const DROPPED_COLUMNS: Record<string, readonly string[]> = {
  plans: ['amount', 'currency', 'price_per_unit_cents'],
  coupons: ['amount_off', 'currency'],
};

function sqlAliases(text: string, table: string): string[] {
  return [...text.matchAll(new RegExp(`"${table}"\\s+(?:AS\\s+)?([a-z_]+)\\b`, 'gi'))]
    .map((match) => match[1]!)
    .filter((alias) => !/^(where|on|set|join|left|inner|order|group|limit)$/i.test(alias));
}

/**
 * Every write of a plan row outside the one owner.
 *
 * @example
 * expect(planWritesOutsideOwner(sourceProgram())).toEqual([]);
 */
export function planWritesOutsideOwner(program: SourceProgram): string[] {
  const found: string[] = [];
  for (const file of program.files) {
    if (program.relative(file) === PLAN_PRICE_OWNER) continue;
    walk(file, (node) => {
      const call = delegateCall(node);
      if (call !== null && call.model === 'plan' && WRITE_METHODS.has(call.method)) {
        found.push(`${program.at(node)} plan.${call.method}: plan writes go through ${PLAN_PRICE_OWNER}`);
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        if (/\b(UPDATE|INSERT\s+INTO)\s+"plans"/i.test(node.getText())) found.push(`${program.at(node)} raw SQL writes "plans"`);
      }
    });
  }
  return [...new Set(found)];
}

/**
 * Every raw SQL string that names a dropped money column: through a table
 * alias, or unqualified in a statement on that table alone.
 *
 * @example
 * expect(droppedColumnsInSql(sourceProgram())).toEqual([]);
 */
export function droppedColumnsInSql(program: SourceProgram): string[] {
  const found: string[] = [];
  for (const file of program.files) {
    walk(file, (node) => {
      if (!ts.isNoSubstitutionTemplateLiteral(node) && !ts.isTemplateExpression(node)) return;
      const text = node.getText();
      for (const [table, columns] of Object.entries(DROPPED_COLUMNS)) {
        const names = columns.join('|');
        for (const alias of sqlAliases(text, table)) {
          const column = new RegExp(`\\b${alias}\\."(${names})"`).exec(text);
          if (column !== null) found.push(`${program.at(node)} raw SQL names "${table}".${column[1]}`);
        }
        const alone = new RegExp(`\\b(?:FROM|UPDATE|INTO)\\s+"${table}"(?![^\`]*\\bJOIN\\b)[^\`]*[^.]"(${names})"`, 'i').exec(text);
        if (alone !== null) found.push(`${program.at(node)} raw SQL names "${table}".${alone[1]}`);
      }
    });
  }
  return [...new Set(found)];
}
