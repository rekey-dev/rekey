/**
 * The dirty-state snapshot, and the reason this file's source stays text.
 *
 * `StickyFormFooter` decides whether a form has unsaved changes by comparing a
 * string built from every named control. The encoding used to join with a
 * literal NUL and SOH, which made git classify the component as binary: every
 * change to it rendered as "Bin 6706 -> 7000 bytes" with no diff, and that
 * component holds the guard that stops an operator navigating away from unsaved
 * work. A reviewer could not see a change to it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeSnapshot } from '@/components/StickyFormFooter';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('the dirty-state snapshot', () => {
  it('is stable, so toggling a value and back again reads as clean', () => {
    const clean = encodeSnapshot([
      ['emailEnabled', 'true'],
      ['provider', 'resend'],
    ]);
    const edited = encodeSnapshot([
      ['emailEnabled', 'false'],
      ['provider', 'resend'],
    ]);
    const toggledBack = encodeSnapshot([
      ['emailEnabled', 'true'],
      ['provider', 'resend'],
    ]);

    expect(edited).not.toBe(clean);
    expect(toggledBack).toBe(clean);
  });

  it('cannot be forged by a value that looks like the separators', () => {
    // Two different forms. Under a plain `name=value` join with printable
    // separators, the first field of the left one swallows the second field of
    // the right one and both encode identically. The length prefixes are what
    // stop that.
    const left = encodeSnapshot([['a', '1,1:b=1:2']]);
    const right = encodeSnapshot([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(left).not.toBe(right);

    // The same attack through the name side.
    expect(encodeSnapshot([['a=1,1:b', '2']])).not.toBe(
      encodeSnapshot([
        ['a', '1'],
        ['b', '2'],
      ]),
    );
  });

  it('distinguishes an empty value from a missing control', () => {
    expect(encodeSnapshot([['a', '']])).not.toBe(encodeSnapshot([]));
    expect(
      encodeSnapshot([
        ['a', ''],
        ['b', ''],
      ]),
    ).not.toBe(encodeSnapshot([['a', '']]));
  });

  it('holds for values carrying the characters the encoding uses', () => {
    for (const value of [':', '=', ',', '0:', '12:x', '']) {
      expect(encodeSnapshot([['field', value]])).toBe(
        `5:field=${value.length}:${value}`,
      );
    }
  });

  it('keeps every panel source file free of control characters', () => {
    // Tab, newline and carriage return only. Anything else makes git treat the
    // file as binary and hides its diff from review. Checked by code point
    // rather than by a character class, because a regular expression that holds
    // control characters is itself a lint error, and writing this test put two
    // of them in this file on the first attempt.
    const carriesControlChar = (text: string): boolean => {
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 9 || code === 10 || code === 13) continue;
        if (code < 32 || code === 127) return true;
      }
      return false;
    };

    const offenders = sourceFiles(srcDir)
      .filter((file) => carriesControlChar(readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcDir, file));

    expect(
      offenders,
      'These files carry a control character, so git classifies them as binary and renders ' +
        'their diffs as "Bin N -> M bytes" with nothing for a reviewer to read. Encode the ' +
        'value instead, the way encodeSnapshot in components/StickyFormFooter.tsx does.',
    ).toEqual([]);
  });
});
