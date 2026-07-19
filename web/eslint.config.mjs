import js from '@eslint/js';
import eslintPluginAstro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
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
  // Reviewed set:html uses: JSON.stringify is XSS-safe; all others go through
  // cleanBodyHtml(). Inline eslint-disable is not supported by astro-eslint-parser
  // for template directives, so we suppress per-file here.
  {
    files: [
      'src/components/Breadcrumbs.astro',
      'src/components/HeadMeta.astro',
      'src/pages/\\[institute\\].astro',
      'src/pages/\\[institute\\]/\\[courseGroup\\].astro',
      'src/pages/\\[institute\\]/\\[courseGroup\\]/\\[seminar\\].astro',
      'src/pages/\\[institute\\]/prepodavatel/\\[id\\].astro',
      'src/pages/aktsii-i-skidki.astro',
      'src/components/home/sections/News.astro',
      'src/pages/oplata.astro',
      'src/pages/sotrudnichestvo-s-nami.astro',
      'src/pages/statyi/\\[slug\\].astro',
      'src/pages/svedeniya-ob-obrazovatelnoy-organizatsii.astro',
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
