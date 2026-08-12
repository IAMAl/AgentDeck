import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Stream Deck action modules decorate their classes with the SDK's `@action`.
  // The production build compiles these with tsc (via @rollup/plugin-typescript);
  // Vitest on Vite 8 transforms with oxc/rolldown, whose default handling of
  // these decorators emits JS that V8 rejects at import ("SyntaxError: Invalid
  // or unexpected token"). Emitting the legacy `__decorate` form instead is
  // valid JS. Tests mock `@elgato/streamdeck`, so the decorator is a no-op at
  // runtime and the legacy-vs-standard calling-convention difference never bites
  // — this only affects the test transform, never the shipped plugin.
  oxc: {
    decorator: {
      legacy: true,
    },
  },
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'bridge/src/__tests__/**/*.test.ts',
      'hooks/src/__tests__/**/*.test.ts',
      'shared/src/__tests__/**/*.test.ts',
      'plugin/src/__tests__/**/*.test.ts',
      'plugin-ulanzi/src/__tests__/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
    ],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: [
        'bridge/src/**/*.ts',
        'shared/src/**/*.ts',
        'plugin/src/**/*.ts',
        'hooks/src/**/*.ts',
        // Only the unit-tested Ulanzi module — pulling the whole package in would
        // count its many untested renderer files against the global thresholds.
        'plugin-ulanzi/src/reconnect-supervisor.ts',
      ],
      exclude: [
        '**/__tests__/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
      thresholds: {
        // Regression guard — set slightly below current levels.
        // Raise these as coverage improves.
        lines: 17,
        functions: 15,
        branches: 14,
        statements: 16,
      },
    },
  },
});
