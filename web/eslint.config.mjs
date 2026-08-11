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
  // Проверенные места set:html. Прежняя формулировка здесь — «JSON.stringify is
  // XSS-safe» — НЕВЕРНА и породила дефект: stringify экранирует кавычки JSON, но
  // не последовательность `</script>`, которая закрывала тег прямо внутри значения
  // (исправлено в 4afb326). Как есть на самом деле:
  //   — JSON-LD идёт через serializeJsonLd() (экранирует каждый `<`), и это
  //     стережёт гейт по исходникам в web/tests/json-ld.test.ts;
  //   — остальное идёт через cleanBodyHtml(), который является НОРМАЛИЗАТОРОМ,
  //     а не санитайзером: он не удаляет <script>, on*-атрибуты и javascript:-URL.
  //     Инвариант «в set:html не попадает исполняемый код» пока не выражен нигде —
  //     это находка B1 аудита 2026-08-08, и allowlist ниже её не закрывает.
  // Inline eslint-disable is not supported by astro-eslint-parser for template
  // directives, so we suppress per-file here.
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
      'src/pages/preview/\\[variant\\]/seminar.astro',
      'src/pages/preview/\\[variant\\]/seminar-undated.astro',
      'src/components/seminars/SeminarArchitectureHeader.astro',
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
