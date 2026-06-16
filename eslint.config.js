// Flat ESLint config (ESLint v9+ / typescript-eslint v8) — see issue #653.
//
// Scope: type-aware linting of application source under `src/` only. Test files
// (`*.test.ts`) and `src/test-support/**` are excluded because they are excluded
// from `tsconfig.json`, so type-checked rules cannot resolve their program.
//
// Ruleset philosophy: start from `recommendedTypeChecked` (which includes the
// high-value, async-aware `no-floating-promises`) and turn OFF only the rules
// that currently report violations, so the gate is GREEN on day one with zero
// source edits. Each disabled rule below is a RATCHET TARGET: a follow-up issue
// should fix the violations and flip the rule back on (delete the line), one
// rule at a time, smallest blast radius first. Do not add blanket inline
// `eslint-disable` comments in source to silence these — fix at the config level
// here until a dedicated cleanup pass addresses them.
//
// Counts below are the violation counts at the time this config was seeded
// (`recommendedTypeChecked`, `src/` non-test files only) and are informational.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['build/**', 'node_modules/**', 'src/**/*.test.ts', 'src/test-support/**'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Ratchet targets: deferred to keep the initial gate green (issue #653) ---
      // High-churn / large cleanups (fix in their own PRs):
      '@typescript-eslint/no-unnecessary-type-assertion': 'off', // 55
      '@typescript-eslint/require-await': 'off', // 16
      '@typescript-eslint/no-unsafe-assignment': 'off', // 13
      '@typescript-eslint/no-unused-vars': 'off', // 12
      '@typescript-eslint/no-unsafe-member-access': 'off', // 12
      '@typescript-eslint/no-redundant-type-constituents': 'off', // 5
      '@typescript-eslint/no-unsafe-argument': 'off', // 5
      '@typescript-eslint/unbound-method': 'off', // 5
      '@typescript-eslint/no-base-to-string': 'off', // 4
      '@typescript-eslint/only-throw-error': 'off', // 3
      '@typescript-eslint/no-explicit-any': 'off', // 2
      '@typescript-eslint/no-unsafe-return': 'off', // 2
      '@typescript-eslint/no-misused-promises': 'off', // 1
      'prefer-const': 'off', // 1
    },
  },
);
