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
);
