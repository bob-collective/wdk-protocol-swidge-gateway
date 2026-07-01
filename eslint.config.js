import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'
import prettier from 'eslint-config-prettier'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'bare.js',
      'index.js',
      'scripts/**',
      'tests/**/*.js',
      'tests/integration/**/*.js',
    ],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  prettier,
]
