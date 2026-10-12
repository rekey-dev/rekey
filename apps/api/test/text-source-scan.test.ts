/**
 * No string the API can send holds an em dash: not an OpenAPI description,
 * not an error `message` or `fix`, not a log line. Held over every string and
 * template literal in `apps/api/src`, so a new route cannot bring one back.
 */

import { describe, expect, it } from 'vitest';
import { sourceProgram } from './source-scan/program.js';
import { emDashLiterals } from './source-scan/text-rules.js';

const EM_DASH = String.fromCharCode(0x2014);

describe('text the API sends', { timeout: 120_000 }, () => {
  it('holds no em dash in any string or template literal', () => {
    expect(emDashLiterals(sourceProgram())).toEqual([]);
  });

  it('is caught in a description, an error fix and a template, and not in a comment', () => {
    const planted = {
      'src/modules/billing/__planted_description__.ts': `export const schema = { description: 'CODE ${EM_DASH} what it means' };`,
      'src/modules/billing/__planted_fix__.ts': `export const error = { message: 'Refused.', fix: "Wait ${EM_DASH} then retry." };`,
      'src/modules/billing/__planted_template__.ts': `export const line = (id: string) => \`payment \${id} ${EM_DASH} skipped\`;`,
      'src/modules/billing/__planted_comment__.ts': `// a comment ${EM_DASH} is not sent\nexport const quiet = 'plain';`,
    };
    const found = emDashLiterals(sourceProgram(planted)).filter((at) => at.includes('__planted_'));
    expect(found).toEqual([
      'src/modules/billing/__planted_description__.ts:1',
      'src/modules/billing/__planted_fix__.ts:1',
      'src/modules/billing/__planted_template__.ts:1',
    ]);
  });
});
