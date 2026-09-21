/**
 * Ban the em dash (and its friends) from comments and user-facing strings.
 *
 * Not a style preference. This codebase ships publicly to the OSS mirror and
 * its marketing voice is explicitly anti-AI-cringe; an em dash reads as
 * machine-written and the maintainer has asked for it gone from comments,
 * commit messages and copy alike. A linter is the only part of that which can
 * be enforced without someone remembering.
 *
 * Comments are checked, plus string literals that carry prose a user reads:
 * the `message` and `fix` of a thrown error, and route `description` fields.
 * Ordinary code strings are left alone, because an em dash inside a regex, a
 * test fixture or a URL is not prose.
 *
 * Autofixable: the dash becomes a comma when it separates clauses, and the
 * fixer refuses anything it cannot rewrite confidently, so `--fix` never
 * silently mangles a sentence.
 */

const DASHES = /[—–]/;

/** en dash between digits is a numeric range, which is correct typography. */
function isNumericRange(text, index) {
  const before = text[index - 1];
  const after = text[index + 1];
  return /\d/.test(before ?? '') && /\d/.test(after ?? '');
}

function report(context, node, raw, offsetInNode) {
  for (let i = 0; i < raw.length; i++) {
    if (!DASHES.test(raw[i])) continue;
    if (raw[i] === '–' && isNumericRange(raw, i)) continue;

    const start = node.range[0] + offsetInNode + i;
    context.report({
      node,
      messageId: 'noEmDash',
      loc: {
        start: context.sourceCode.getLocFromIndex(start),
        end: context.sourceCode.getLocFromIndex(start + 1),
      },
      // Auto-fix only the unambiguous clause break: a dash with a space before
      // it, and either a space or a line wrap after. A comma carries that. Any
      // other shape is left for a human, because turning "9-5" or "A--B" into
      // prose is a judgement a fixer should not make.
      fix(fixer) {
        const prev = raw[i - 1];
        const next = raw[i + 1];
        if (prev !== ' ') return null;
        // A dash that OPENS a wrapped comment line has only ` * ` before it, so
        // replacing `[space, dash]` welds the comma onto the asterisk and
        // produces ` *, text`. Decline: a human should rejoin the sentence.
        const lineStart = raw.lastIndexOf('\n', i) + 1;
        if (/^[\s*]*$/.test(raw.slice(lineStart, i - 1))) return null;
        if (next === ' ') {
          return fixer.replaceTextRange([start - 1, start + 1], ',');
        }
        // End of a wrapped comment line: the sentence continues on the next
        // one, so the dash is still a clause break.
        if (next === undefined || next === '\n' || next === '\r') {
          return fixer.replaceTextRange([start - 1, start + 1], ',');
        }
        return null;
      },
    });
  }
}

/** Every string literal in a `a + b + c` chain, which nests to the left. */
function stringParts(node, out = []) {
  if (!node) return out;
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    stringParts(node.left, out);
    stringParts(node.right, out);
  } else if (node.type === 'Literal' && typeof node.value === 'string') {
    out.push(node);
  }
  return out;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow em and en dashes in comments and user-facing prose.' },
    fixable: 'code',
    schema: [],
    messages: {
      noEmDash:
        'No em or en dashes. They read as AI-written. Restructure the sentence: a comma, a colon, or two sentences almost always reads better.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          report(context, comment, comment.value, comment.type === 'Block' ? 2 : 2);
        }
      },
      // Prose a user actually reads: RekeyError's `message` / `fix`, and the
      // `description` on a route schema.
      Property(node) {
        const key = node.key?.name ?? node.key?.value;
        if (key !== 'message' && key !== 'fix' && key !== 'description') return;
        if (node.value?.type !== 'Literal' || typeof node.value.value !== 'string') return;

        // The RAW source text, not the cooked value.
        //
        // eslint-disable-next-line local/no-em-dash -- the dash is the example.
        // `node.value.value` has escapes already resolved, so `'a\nb, c'` is 7
        // characters cooked and 8 in source. Offsets computed from the cooked
        // string then land one character to the LEFT per preceding escape, and
        // the fixer eats a real character while leaving the dash in place. The
        // corrupted line still fails the rule, and `--fix` on pre-commit would
        // block every later commit touching the file, having already written
        // the damage to disk.
        const raw = sourceCode.getText(node.value);
        report(context, node.value, raw.slice(1, -1), 1);
      },

      // The OpenAPI helpers take their description as a positional argument, so
      // the text that ends up in the PUBLISHED contract is not under a
      // `description:` key at all. `mfa.routes.ts` carried the same sentence
      // twice, fixed at line 285 where it was a key and untouched at line 301
      // where it was an argument to `ok()`.
      'CallExpression'(node) {
        const fn = node.callee?.name;
        if (fn !== 'ok' && fn !== 'okPage' && fn !== 'okArray' && fn !== 'okArrayOf') return;
        for (const arg of node.arguments) {
          for (const part of stringParts(arg)) {
            report(context, part, sourceCode.getText(part).slice(1, -1), 1);
          }
        }
      },

      // Prose is usually CONCATENATED here, because these strings are long
      // enough to wrap. `fix: 'one clause ' + 'and another'` is a
      // BinaryExpression, not a Literal, so the visitor above never saw it and
      // the same sentence could be fixed in one place and left in another.
      // `mfa.routes.ts` had exactly that: line 285 rewritten, line 301 not.
      'Property > BinaryExpression'(node) {
        const prop = node.parent;
        const key = prop.key?.name ?? prop.key?.value;
        if (key !== 'message' && key !== 'fix' && key !== 'description') return;
        // Walks the WHOLE chain: `a + b + c` nests to the left, so taking only
        // `left` and `right` checked two parts of a four-part sentence.
        for (const part of stringParts(node)) {
          report(context, part, sourceCode.getText(part).slice(1, -1), 1);
        }
      },
    };
  },
};
