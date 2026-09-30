/**
 * Customers read every string the portal renders. An em dash reads as
 * machine-written copy, so none may appear outside comments.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('portal copy', () => {
  it('has no em dash outside comments', () => {
    const offenders = sourceFiles(SRC).filter((file) => withoutComments(readFileSync(file, 'utf8')).includes('—'));
    expect(offenders).toEqual([]);
  });
});
