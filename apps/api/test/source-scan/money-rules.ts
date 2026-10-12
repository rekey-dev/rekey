/**
 * The two money rules held over the whole source tree, as functions of a
 * type-checked program so a test can also point them at a planted violation.
 *
 *   1. A subscription's `planPriceId`, `currency` and `unitAmount` are
 *      written in `billing/subscription-snapshot.ts` and nowhere else.
 *   2. A plan's `amount`, `currency` and `pricePerUnitCents` are read and
 *      written in `plans/default-price.ts` and nowhere else.
 */

import ts from 'typescript';
import { declaredIn, type SourceProgram } from './program.js';

export const SUBSCRIPTION_PRICE_WRITER = 'src/modules/billing/subscription-snapshot.ts';
export const PLAN_PRICE_OWNER = 'src/modules/plans/default-price.ts';

const SUBSCRIPTION_PRICE_COLUMNS = ['planPriceId', 'currency', 'unitAmount'] as const;
const PLAN_PRICE_COLUMNS = new Set(['amount', 'currency', 'pricePerUnitCents']);
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

function sqlPlanAliases(text: string): string[] {
  return [...text.matchAll(/"plans"\s+(?:AS\s+)?([a-z_]+)\b/gi)].map((match) => match[1]!).filter((alias) => !/^(where|on|set|join|left|inner)$/i.test(alias));
}

/**
 * Every read or write of a plan's price columns outside the one owner:
 * property reads, destructuring, Prisma `select`, `where` and `orderBy`,
 * plan writes, and raw SQL.
 *
 * @example
 * expect(planPriceColumnUses(sourceProgram())).toEqual([]);
 */
export function planPriceColumnUses(program: SourceProgram): string[] {
  const found: string[] = [];
  const { checker } = program;
  for (const file of program.files) {
    if (program.relative(file) === PLAN_PRICE_OWNER) continue;
    walk(file, (node) => {
      if (ts.isPropertyAccessExpression(node) && PLAN_PRICE_COLUMNS.has(node.name.text)) {
        if (declaredIn(checker.getSymbolAtLocation(node.name), ['$PlanPayload'])) {
          found.push(`${program.at(node)} reads ${node.getText().slice(0, 60)}`);
        }
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const name = node.propertyName ?? node.name;
        if (ts.isIdentifier(name) && PLAN_PRICE_COLUMNS.has(name.text)) {
          const symbol = checker.getTypeAtLocation(node.parent).getProperty(name.text);
          if (declaredIn(symbol, ['$PlanPayload'])) found.push(`${program.at(node)} destructures ${name.text}`);
        }
      }
      const call = delegateCall(node);
      if (call !== null && call.model === 'plan') {
        if (WRITE_METHODS.has(call.method) || call.method === 'delete' || call.method === 'deleteMany') {
          if (call.method.startsWith('delete')) return;
          found.push(`${program.at(node)} plan.${call.method}: plan writes go through ${PLAN_PRICE_OWNER}`);
        }
        if (call.args !== undefined) {
          walk(call.args, (inner) => {
            if (!ts.isPropertyAssignment(inner) && !ts.isShorthandPropertyAssignment(inner)) return;
            if (!ts.isIdentifier(inner.name) || !PLAN_PRICE_COLUMNS.has(inner.name.text)) return;
            // Columns of a related model reached through the plan query are that model's.
            for (let up: ts.Node = inner.parent; up !== call.args; up = up.parent) {
              if (ts.isPropertyAssignment(up) && ts.isIdentifier(up.name) && /^(defaultPrice|prices|subscriptions|licenses|entitlements)$/.test(up.name.text)) return;
            }
            found.push(`${program.at(inner)} plan.${call.method} names ${inner.name.text}`);
          });
        }
      }
      // `plan: { select: { amount: true } }` under another model's query.
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === 'plan' &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        for (const clause of node.initializer.properties) {
          if (!ts.isPropertyAssignment(clause) || !ts.isIdentifier(clause.name)) continue;
          if (!/^(select|where|orderBy|is|isNot)$/.test(clause.name.text) || !ts.isObjectLiteralExpression(clause.initializer)) continue;
          for (const field of clause.initializer.properties) {
            if (field.name !== undefined && ts.isIdentifier(field.name) && PLAN_PRICE_COLUMNS.has(field.name.text)) {
              found.push(`${program.at(field)} plan ${clause.name.text} names ${field.name.text}`);
            }
          }
        }
      }
      if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
        const text = node.getText();
        for (const alias of sqlPlanAliases(text)) {
          const column = new RegExp(`\\b${alias}\\."(amount|currency|price_per_unit_cents)"`).exec(text);
          if (column !== null) found.push(`${program.at(node)} raw SQL reads "plans".${column[1]}`);
        }
        if (/FROM\s+"plans"\s+WHERE[^`]*"(amount|price_per_unit_cents)"/i.test(text)) {
          found.push(`${program.at(node)} raw SQL filters "plans" on a price column`);
        }
      }
    });
  }
  return [...new Set(found)];
}
