import js from '@eslint/js';
import eslintPluginAstro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      // Вывод демо-сборки — такой же сгенерированный артефакт, как dist/. Без этой
      // строки eslint шёл в собранный бандл и в индекс Pagefind: 1061 ошибка на коде,
      // который мы не писали.
      'dist-demo/**',
      // Вывод сборки роли `stand` (задача 6.15) — тот же сгенерированный артефакт.
      'dist-stand/**',
      '.astro/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...eslintPluginAstro.configs.recommended,
  {
    files: ['**/*.astro'],
    rules: {
      'astro/no-set-html-directive': 'error',
    },
  },
  // Проверенные места set:html: JSON-LD через serializeJsonLd() и единственный
  // rich-content sink RichContent.astro, который проверяет runtime token и
  // вызывает terminal sanitizer непосредственно у set:html.
  {
    files: [
      'src/components/Breadcrumbs.astro',
      'src/components/HeadMeta.astro',
      'src/components/RichContent.astro',
    ],
    rules: {
      'astro/no-set-html-directive': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['tests/**/*.{ts,js}', '**/*.spec.ts', '**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
