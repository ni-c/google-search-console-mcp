import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured 2026-08-28 at 95.14 / 89.06 / 97.77 / 95.47. These sit below
      // that with room for an honest refactor — a floor to defend with new
      // tests, never a number to lower when a run goes red.
      //
      // Branches has the least headroom because the tool bodies are mostly
      // `if (value !== undefined)` over optional arguments; test/tools-optional.test.ts
      // is what keeps that half honest, and a new optional argument belongs in it.
      thresholds: {
        statements: 92,
        branches: 86,
        functions: 93,
        lines: 92,
      },
    },
  },
});
