import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      '*.db',
      '*.db-shm',
      '*.db-wal',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-constant-condition': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
