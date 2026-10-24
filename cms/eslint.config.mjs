import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      '.strapi/**',
      'node_modules/**',
      'build/**',
      '.cache/**',
      '.tmp/**',
      'coverage/**',
      'types/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Байты этих файлов закреплены SHA-256 в database/migrations/plan.json: правка ради
    // правил, появившихся в @eslint/js 10, — это новый релиз миграций, а не чистка стиля.
    files: ['scripts/run-data-migrations.mjs', 'scripts/normalize-null-documents-state.mjs'],
    rules: {
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
);
