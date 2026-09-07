/**
 * Every function that walks text or a structure somebody else sized, timed at
 * the largest input the code accepts. A regex or a loop that is quadratic
 * gets its line here before it gets merged.
 */
import { describe, expect, it } from 'vitest';

import { escapeCell } from '../src/analytics.js';
import { cleanText, cleanValue, upstreamText } from '../src/clean.js';
import { MAX_ERROR_BODY_BYTES } from '../src/api.js';
import {
  budget,
  redactCredentials,
  ResultTooLargeError,
  statusHint,
} from '../src/result.js';

function timed(fn: () => void): number {
  const started = performance.now();
  fn();
  return performance.now() - started;
}

describe('linear time at the ceiling', () => {
  it('budget() over twenty thousand long strings', () => {
    // Five megabytes of 250-character fields: one cut per round made this
    // eleven seconds, and it gave up at the end of them.
    const many: Record<string, string> = {};
    for (let i = 0; i < 20_000; i++) many[`k${i}`] = 's'.repeat(250);
    expect(
      timed(() => {
        expect(() => budget(many)).toThrow(ResultTooLargeError);
      })
    ).toBeLessThan(1500);
  });

  it('budget() over one huge string and one huge list', () => {
    const data = {
      text: 'x'.repeat(4_000_000),
      list: Array.from({ length: 50_000 }, (_, i) => ({
        i,
        v: 'y'.repeat(50),
      })),
    };
    expect(timed(() => budget(data))).toBeLessThan(1500);
  });

  it('redactCredentials on repeated BEGIN markers and on a long message', () => {
    expect(
      timed(() => redactCredentials('-----BEGIN PRIVATE KEY-----'.repeat(8000)))
    ).toBeLessThan(200);
    expect(timed(() => redactCredentials('a'.repeat(1_000_000)))).toBeLessThan(
      200
    );
  });

  it('cleanText and cleanValue on a megabyte', () => {
    const esc = String.fromCharCode(27);
    const text = `${esc}x`.repeat(500_000);
    expect(timed(() => cleanText(text))).toBeLessThan(500);
    expect(timed(() => cleanValue({ a: [text, { b: text }] }))).toBeLessThan(
      1500
    );
  });

  it('upstreamText and statusHint on the error-body ceiling', () => {
    const body = `{"x":"${'<'.repeat(MAX_ERROR_BODY_BYTES)}"}`;
    expect(timed(() => upstreamText(body))).toBeLessThan(200);
    expect(timed(() => statusHint(403, 'search-console', body))).toBeLessThan(
      200
    );
  });

  it('escapeCell on a cell of backslashes and pipes', () => {
    const cell = '\\|'.repeat(50_000);
    expect(timed(() => escapeCell(cell))).toBeLessThan(200);
  });
});
