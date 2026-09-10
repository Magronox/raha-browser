// ESLint flat config. Runs in CI and on dev machines (`npm run lint`).
// The two custom no-restricted-imports blocks enforce the architecture
// boundaries described in docs/INVARIANTS.md — do not weaken them.
import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'vendor/**', 'release/**', 'test-results/**', 'playwright-report/**'] },

  js.configs.recommended,

  // Base language options for all our code.
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: {
      'no-var': 'error',
      // ignoreReadBeforeAssign: the declare -> close-over -> assign-once
      // pattern (e.g. `push` in src/main/index.js) genuinely needs `let`.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // INVARIANT: pure layers must not touch electron or node builtins.
  // src/shared  — imported by main, UI, and tests alike.
  // src/main/core — the electron-agnostic engine; talks to the platform only
  //                 through injected adapter objects (see src/main/electron/).
  {
    files: ['src/shared/**/*.js', 'src/main/core/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*'], message: 'Pure layers must not import electron. Use an injected adapter (docs/INVARIANTS.md #1).' },
            { group: ['node:*', 'fs', 'path', 'os', 'child_process', 'http', 'https', 'net'], message: 'Pure layers must not import node builtins. Use an injected adapter (docs/INVARIANTS.md #1).' },
          ],
        },
      ],
    },
  },

  // INVARIANT: only the adapter layer and the entrypoint may import electron.
  {
    files: ['src/ui/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        requestAnimationFrame: 'readonly',
        CustomEvent: 'readonly',
        Image: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        DragEvent: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['electron', 'electron/*', 'node:*', 'fs', 'path'], message: 'UI is a plain web page; it may only talk to window.raha (docs/INVARIANTS.md #2).' },
          ],
        },
      ],
    },
  },

  // Node-flavored files (main adapters, tests, scripts).
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.cjs', 'tests/**/*.{js,mjs}', 'scripts/**/*.mjs', 'playwright.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
      },
    },
  },

  // UI-driving tests interleave node code with callbacks that execute inside
  // the page (page.evaluate / $$eval / addInitScript) — those callbacks need
  // browser globals too.
  {
    files: ['tests/ui/**/*.mjs', 'tests/e2e/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        Event: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly',
      },
    },
  },
];
